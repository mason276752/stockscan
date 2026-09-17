//! stockscan-static: the parts of the static-site build that are slow in
//! Node (server/tools/build-static.mjs calls this; the logic that decides
//! what goes into the indexes stays in JavaScript so the two builds cannot
//! drift). Three commands, all parallel over the machine's cores:
//!
//!   copy <from> <to> [--link]        replace <to> with a copy of the tree
//!                                    <from> (*.tmp skipped); --link makes
//!                                    hard links instead of copies
//!   decode <store> <zdict-dir>       every filings/**/*.zst and
//!                                    scores/**/*.zst of the store, decoded
//!                                    with the dictionaries; prints one JSON
//!                                    object to stdout:
//!                                      { "filings": { accession: <data.filing> },
//!                                        "scores":  { accession: <score> } }
//!                                    (numbers are passed through verbatim)
//!   compress <level> <file>...       <file> -> <file>.zst (the original is
//!                                    removed), zstd at <level>
//!
//! Exit status 1 with a message on stderr when something is wrong.
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::value::RawValue;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use walkdir::WalkDir;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("copy") => copy(&args[1..]),
        Some("decode") => decode(&args[1..]),
        Some("compress") => compress(&args[1..]),
        _ => Err("usage: stockscan-static copy <from> <to> [--link] | decode <store> <zdict-dir> | compress <level> <file>...".to_string()),
    };
    if let Err(e) = result {
        eprintln!("stockscan-static: {e}");
        process::exit(1);
    }
}

// ---- copy ----------------------------------------------------------------

fn copy(args: &[String]) -> Result<(), String> {
    let (from, to) = match (args.first(), args.get(1)) {
        (Some(f), Some(t)) => (PathBuf::from(f), PathBuf::from(t)),
        _ => return Err("copy: need <from> <to>".into()),
    };
    let link = args.iter().skip(2).any(|a| a == "--link");
    if !from.is_dir() {
        return Err(format!("copy: {} is not a directory", from.display()));
    }
    if to.exists() {
        fs::remove_dir_all(&to).map_err(|e| format!("copy: removing {}: {e}", to.display()))?;
    }
    // directories first (in order, so parents exist), then the files in parallel
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in WalkDir::new(&from).min_depth(1) {
        let entry = entry.map_err(|e| format!("copy: {e}"))?;
        let rel = entry.path().strip_prefix(&from).unwrap().to_path_buf();
        if entry.file_type().is_dir() {
            dirs.push(rel);
        } else if entry.file_type().is_file() && entry.path().extension().map_or(true, |x| x != "tmp") {
            files.push(rel);
        }
    }
    fs::create_dir_all(&to).map_err(|e| format!("copy: {e}"))?;
    for d in &dirs {
        fs::create_dir_all(to.join(d)).map_err(|e| format!("copy: {e}"))?;
    }
    let bytes: Result<u64, String> = files
        .par_iter()
        .map(|rel| {
            let src = from.join(rel);
            let dst = to.join(rel);
            if link {
                if fs::hard_link(&src, &dst).is_ok() {
                    return fs::metadata(&src).map(|m| m.len()).map_err(|e| e.to_string());
                }
            }
            fs::copy(&src, &dst).map_err(|e| format!("copy: {} -> {}: {e}", src.display(), dst.display()))
        })
        .sum();
    let bytes = bytes?;
    eprintln!("stockscan-static: copied {} files, {:.0} MB{}", files.len(), bytes as f64 / 1048576.0, if link { " (hard links)" } else { "" });
    Ok(())
}

// ---- decode --------------------------------------------------------------

struct Dict {
    filings: Vec<u8>,
    scores: Vec<u8>,
}

fn decode(args: &[String]) -> Result<(), String> {
    let (store, zdict) = match (args.first(), args.get(1)) {
        (Some(s), Some(z)) => (PathBuf::from(s), PathBuf::from(z)),
        _ => return Err("decode: need <store> <zdict-dir>".into()),
    };
    let dict = Dict {
        filings: fs::read(zdict.join("filings-v1.zdict")).map_err(|e| format!("decode: filings dictionary: {e}"))?,
        scores: fs::read(zdict.join("scores-v1.zdict")).map_err(|e| format!("decode: scores dictionary: {e}"))?,
    };
    let filings = decode_tree(&store.join("filings"), &dict.filings, "filings")?;
    let scores = decode_tree(&store.join("scores"), &dict.scores, "scores")?;
    eprintln!("stockscan-static: decoded {} filing headers, {} scores", filings.len(), scores.len());

    // one JSON object, streamed out: {"filings":{...},"scores":{...}}
    let stdout = io::stdout();
    let mut out = io::BufWriter::with_capacity(1 << 20, stdout.lock());
    let write_map = |out: &mut dyn Write, name: &str, map: &BTreeMap<String, String>| -> io::Result<()> {
        write!(out, "{}:{{", serde_json::to_string(name).unwrap())?;
        for (i, (k, v)) in map.iter().enumerate() {
            if i > 0 {
                out.write_all(b",")?;
            }
            out.write_all(serde_json::to_string(k).unwrap().as_bytes())?;
            out.write_all(b":")?;
            out.write_all(v.as_bytes())?;
        }
        out.write_all(b"}")
    };
    (|| -> io::Result<()> {
        out.write_all(b"{")?;
        write_map(&mut out, "filings", &filings)?;
        out.write_all(b",")?;
        write_map(&mut out, "scores", &scores)?;
        out.write_all(b"}\n")?;
        out.flush()
    })()
    .map_err(|e| format!("decode: writing output: {e}"))
}

// the shape of the store files, as far as the build needs them
#[derive(Deserialize)]
struct FilingFile<'a> {
    accession: Option<&'a str>,
    #[serde(borrow)]
    data: Option<FilingData<'a>>,
}
#[derive(Deserialize)]
struct FilingData<'a> {
    #[serde(borrow)]
    filing: Option<&'a RawValue>,
}
#[derive(Deserialize)]
struct ScoreFile<'a> {
    accession: Option<&'a str>,
    #[serde(borrow)]
    score: Option<&'a RawValue>,
}

// accession -> the JSON text of the wanted member (`data.filing` of a filing
// file, `score` of a score file), from every .zst / .br under `dir`
fn decode_tree(dir: &Path, dict: &[u8], kind: &str) -> Result<BTreeMap<String, String>, String> {
    if !dir.is_dir() {
        return Ok(BTreeMap::new());
    }
    let files: Vec<PathBuf> = WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| matches!(p.extension().and_then(|x| x.to_str()), Some("zst") | Some("br")))
        .collect();
    let decoded: Vec<Result<Option<(String, String)>, String>> = files
        .par_iter()
        .map(|file| -> Result<Option<(String, String)>, String> {
            let raw = fs::read(file).map_err(|e| format!("{}: {e}", file.display()))?;
            let json = if file.extension().map_or(false, |x| x == "br") {
                let mut out = Vec::new();
                brotli_decompressor::BrotliDecompress(&mut raw.as_slice(), &mut out).map_err(|e| format!("{}: brotli: {e}", file.display()))?;
                out
            } else {
                let mut d = zstd::bulk::Decompressor::with_dictionary(dict).map_err(|e| e.to_string())?;
                // the frame header carries the content size; 32 MB is far above any filing
                d.decompress(&raw, 32 << 20).map_err(|e| format!("{}: zstd: {e}", file.display()))?
            };
            // only the wanted member is looked at; the rest of the file (the
            // statements, most of a filing) is skimmed over, and the member's
            // text is passed through untouched
            let (accession, member): (Option<&str>, Option<&RawValue>) = if kind == "filings" {
                let f: FilingFile = serde_json::from_slice(&json).map_err(|e| format!("{}: json: {e}", file.display()))?;
                (f.accession, f.data.and_then(|d| d.filing))
            } else {
                let f: ScoreFile = serde_json::from_slice(&json).map_err(|e| format!("{}: json: {e}", file.display()))?;
                (f.accession, f.score)
            };
            Ok(match (accession, member) {
                (Some(a), Some(m)) => Some((a.to_string(), m.get().to_string())),
                _ => None,
            })
        })
        .collect();
    let mut map = BTreeMap::new();
    let mut unreadable = 0;
    for r in decoded {
        match r {
            Ok(Some((k, v))) => {
                map.insert(k, v);
            }
            Ok(None) => {}
            Err(e) => {
                // the store drops unreadable files on its own; here they are just left out
                unreadable += 1;
                if unreadable <= 5 {
                    eprintln!("stockscan-static: {e}");
                }
            }
        }
    }
    if unreadable > 0 {
        eprintln!("stockscan-static: {unreadable} unreadable {kind} files skipped");
    }
    Ok(map)
}

// ---- compress ------------------------------------------------------------

fn compress(args: &[String]) -> Result<(), String> {
    let level: i32 = args.first().and_then(|l| l.parse().ok()).ok_or("compress: need <level> <file>...")?;
    let files: Vec<&String> = args.iter().skip(1).collect();
    if files.is_empty() {
        return Err("compress: no files".into());
    }
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2) as u32;
    // the big file first so the small ones fill in behind it
    let mut sized: Vec<(u64, &String)> = files.iter().map(|f| (fs::metadata(f).map(|m| m.len()).unwrap_or(0), *f)).collect();
    sized.sort_by(|a, b| b.0.cmp(&a.0));
    sized.par_iter().try_for_each(|(_, file)| -> Result<(), String> {
        let data = fs::read(file).map_err(|e| format!("compress: {file}: {e}"))?;
        let mut enc = zstd::stream::write::Encoder::new(Vec::with_capacity(data.len() / 4), level).map_err(|e| e.to_string())?;
        enc.multithread(threads).map_err(|e| e.to_string())?;
        enc.write_all(&data).map_err(|e| e.to_string())?;
        let out = enc.finish().map_err(|e| e.to_string())?;
        let target = format!("{file}.zst");
        fs::write(&target, &out).map_err(|e| format!("compress: {target}: {e}"))?;
        fs::remove_file(file).map_err(|e| format!("compress: removing {file}: {e}"))?;
        eprintln!("stockscan-static: {} {:.1} MB ({:.1} MB raw)", Path::new(&target).file_name().unwrap().to_string_lossy(), out.len() as f64 / 1048576.0, data.len() as f64 / 1048576.0);
        Ok(())
    })
}
