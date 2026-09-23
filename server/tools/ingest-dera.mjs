// Fill in the filings the parser cannot read, from SEC's Financial
// Statement Data Sets (one zip per calendar quarter, back to 2009q1).
//
//   npm run ingest:dera                      # every quarter, 2009q1 to now
//   npm run ingest:dera -- --from 2015q1     # only from there on
//   npm run ingest:dera -- --quarter 2012q1  # just that one
//   npm run ingest:dera -- --cik 320193      # one company, for checking
//   npm run ingest:dera -- --dry-run         # count what would be saved
//   npm run ingest:dera -- --compare         # rebuild filings the store
//                                            # already parsed and diff the
//                                            # scores, to see what is lost
//
// Before 2019 a filer tagged its numbers in a separate instance document
// rather than in the HTML, and ixbrl.js only reads Inline XBRL - so EDGAR's
// isInlineXBRL flag is the line this draws: a filing EDGAR marks inline is
// left to the crawler, which parses the document itself and gets the
// headings, the indent hierarchy and the cover page with it; everything
// else is rebuilt from the datasets (dera.js says exactly what that costs).
// --include-inline fills those too, which is much faster than crawling them
// but saves the thinner record, and never replaces a filing already saved.
//
// EDGAR stays the authority for what a filing *is*: the accession, the form,
// the exact period end (the datasets round every date to a month end) and
// the document URLs all come from the company's submissions record, and a
// submission EDGAR does not list is skipped rather than guessed at.
//
// Scores are not written here. Run `npm run rescore` afterwards - it scores
// every saved filing that has none, and by then the neighbouring quarters a
// quarterly filing needs are all in the store.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { openStore, store, requireVersion } from '../lib/store.js';
import { SecClient } from '../lib/secClient.js';
import { getCompany, refreshTickers, savedTickers } from '../lib/edgar.js';
import { zipEntryStream } from '../lib/remoteZip.js';
import { SCRAPE_VERSION } from '../lib/scrape.js';
import { DERA_FORMS, dateSnapper, deraResult } from '../lib/dera.js';
import { scoreFiling } from '../lib/scoreModel.js';
import { reclassify } from '../lib/statementTypes.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATASETS = 'https://www.sec.gov/files/dera/data/financial-statement-data-sets/';
const ZIPS = process.env.STOCKSCAN_DERA || path.join(REPO, 'data', 'dera');
const FIRST = '2009q1'; // the first quarter SEC published
const COMPANY_TTL = 30 * 24 * 3600 * 1000; // a submissions record this run may reuse

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const DRY = args.includes('--dry-run');
const COMPARE = args.includes('--compare');
const INCLUDE_INLINE = args.includes('--include-inline');
const KEEP = !args.includes('--discard-zips');
const ONLY_CIK = opt('--cik') ? Number(opt('--cik')) : null;
const LIMIT = Number(opt('--limit')) || 0;
// Filings held in memory per pass over the quarter's files; more passes, less memory.
const BATCH = Math.max(1, Number(opt('--batch')) || 2500);

const log = (m) => console.log(`ingest-dera: ${m}`);
const n = (x) => Number(x).toLocaleString('en-US');
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0);

// ---------------------------------------------------------------- quarters

const quarterOf = (d) => `${d.getUTCFullYear()}q${Math.floor(d.getUTCMonth() / 3) + 1}`;
const parseQuarter = (s) => {
  const m = /^(\d{4})q([1-4])$/.exec(String(s || '').toLowerCase());
  if (!m) throw new Error(`not a quarter: ${s} (want e.g. 2012q1)`);
  return { year: Number(m[1]), q: Number(m[2]) };
};
// newest first: what the app is most likely to want is filled in first
function quarters(from, to) {
  const a = parseQuarter(from);
  const b = parseQuarter(to);
  const out = [];
  for (let { year, q } = b; year > a.year || (year === a.year && q >= a.q);) {
    out.push(`${year}q${q}`);
    if (--q === 0) {
      q = 4;
      year--;
    }
  }
  return out;
}

// ------------------------------------------------------------------ the tsv

// Every file in the set is tab separated with a header row.
const header = (line) =>
  Object.fromEntries(
    line
      .replace(/\r$/, '')
      .split('\t')
      .map((h, i) => [h, i]),
  );

// The rows of the accessions in hand, kept as the raw lines and split only
// when a filing is built: num.txt is 600 MB of text a quarter and most of it
// belongs to submissions this is not here for.
//
// There is no streaming one filing at a time: 2026q2 is grouped by
// accession but the quarters SEC re-published in 2024 are sorted by tag, so
// a filing's rows are scattered the length of the file. A pass therefore
// holds the lines of a batch of accessions and drops the rest; a quarter
// with more to rebuild than one batch takes another pass.
async function collectInto(zip, name, into) {
  const rl = readline.createInterface({ input: await zipEntryStream(zip, name), crlfDelay: Infinity });
  let col = null;
  for await (const line of rl) {
    if (!col) {
      col = header(line);
      continue;
    }
    const t = line.indexOf('\t');
    if (t < 0) continue;
    into.get(line.slice(0, t))?.push(line);
  }
  return col;
}

const split = (line) => line.replace(/\r$/, '').split('\t');
const preRow = (line, c) => {
  const f = split(line);
  return {
    report: Number(f[c.report]),
    line: Number(f[c.line]),
    stmt: f[c.stmt],
    inpth: Number(f[c.inpth]),
    tag: f[c.tag],
    version: f[c.version],
    plabel: f[c.plabel],
    negating: Number(f[c.negating]),
  };
};
const numRow = (line, c) => {
  const f = split(line);
  return {
    tag: f[c.tag],
    version: f[c.version],
    ddate: f[c.ddate],
    qtrs: Number(f[c.qtrs]),
    uom: f[c.uom],
    segments: f[c.segments] || '',
    coreg: f[c.coreg] || '',
    value: f[c.value] ?? '',
  };
};

// One batch's filings, each with its pre.txt and num.txt rows.
async function* filingRows(zip, accessions) {
  const pre = new Map(accessions.map((a) => [a, []]));
  const num = new Map(accessions.map((a) => [a, []]));
  const preCol = await collectInto(zip, 'pre.txt', pre);
  const numCol = await collectInto(zip, 'num.txt', num);
  for (const adsh of accessions) {
    yield {
      adsh,
      pre: pre.get(adsh).map((l) => preRow(l, preCol)),
      num: num.get(adsh).map((l) => numRow(l, numCol)),
    };
    // the lines of a filing already built are of no further use
    pre.set(adsh, []);
    num.set(adsh, []);
  }
}

// -------------------------------------------------------------- the dataset

async function ensureZip(client, quarter) {
  const file = path.join(ZIPS, `${quarter}.zip`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1024) return file;
  fs.mkdirSync(ZIPS, { recursive: true });
  const url = `${DATASETS}${quarter}.zip`;
  let res;
  try {
    // 60-90 MB a quarter, so straight to disk - and patient, because a run
    // that has been pulling from sec.gov for a while gets 429s back
    res = await client.fetch(url, { retries: 8 });
  } catch (err) {
    if (err.status === 404) return null; // not published (a quarter still open)
    throw err;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  log(`${quarter}: downloaded ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
  return file;
}

// sub.txt is small enough to read whole.
async function readSubmissions(zip) {
  const rl = readline.createInterface({ input: await zipEntryStream(zip, 'sub.txt'), crlfDelay: Infinity });
  let col = null;
  const out = [];
  for await (const line of rl) {
    if (!col) {
      col = header(line);
      continue;
    }
    const f = line.replace(/\r$/, '').split('\t');
    if (f.length < 10) continue;
    out.push({
      adsh: f[col.adsh],
      cik: Number(f[col.cik]),
      name: f[col.name],
      form: f[col.form],
      period: f[col.period],
      fy: f[col.fy] || null,
      fp: f[col.fp] || null,
      filed: f[col.filed],
      instance: f[col.instance],
    });
  }
  return out;
}

// tag.txt: the datatype (which says what a number's unit means), the standard
// label and SEC's definition of every tag the quarter uses.
async function readTags(zip) {
  const rl = readline.createInterface({ input: await zipEntryStream(zip, 'tag.txt'), crlfDelay: Infinity });
  let col = null;
  const map = new Map();
  for await (const line of rl) {
    if (!col) {
      col = header(line);
      continue;
    }
    const f = line.replace(/\r$/, '').split('\t');
    if (f.length < 5) continue;
    map.set(`${f[col.tag]}/${f[col.version]}`, {
      datatype: f[col.datatype] || null,
      tlabel: f[col.tlabel] || null,
      doc: f[col.doc] || null,
    });
  }
  return map;
}

// ------------------------------------------------------------- EDGAR lookup

// EDGAR's record of every filing of the companies this quarter touches,
// as accession -> the filing, plus a date snapper per company. A record
// already on disk is reused (they are in git and the crawler keeps them
// fresh); a company EDGAR will not answer for is counted and skipped.
async function edgarIndex(client, ciks, stats) {
  const byAccession = new Map();
  const snapByCik = new Map();
  let done = 0;
  for (const cik of ciks) {
    if (++done % 500 === 0) log(`  EDGAR filing lists ${n(done)} / ${n(ciks.length)} companies (${secs()} s)`);
    let company;
    try {
      company = await getCompany(client, cik, {
        inlineOnly: false,
        maxAge: COMPANY_TTL,
      });
    } catch (err) {
      stats.noCompany++;
      if (err.status !== 404) console.warn(`ingest-dera: CIK ${cik}: ${err.message}`);
      continue;
    }
    for (const f of company.filings) byAccession.set(f.accession, f);
    snapByCik.set(cik, dateSnapper(company.filings.map((f) => f.reportDate)));
  }
  return { byAccession, snapByCik };
}

// ------------------------------------------------------------------- compare
//
// What the rebuild loses, measured rather than guessed: rebuild a filing the
// crawler already parsed and put the two scores side by side.

async function compareOne(sub, rows, edgar, tagOf, dataset) {
  const filing = edgar.byAccession.get(sub.adsh);
  const saved = store.getFiling(sub.adsh);
  if (!filing || !saved) return null;
  const built = deraResult({
    filing,
    sub,
    pre: rows.pre,
    num: rows.num,
    tagOf,
    snap: edgar.snapByCik.get(sub.cik),
    dataset,
  });
  if (!built) return { accession: sub.adsh, cik: sub.cik, built: false };
  // both sides scored the same way (this one filing alone), so the only
  // thing the difference can be is what the rebuild lost
  const parsed = scoreFiling(reclassify(saved));
  const dera = scoreFiling(built);
  return {
    accession: sub.adsh,
    cik: sub.cik,
    built: true,
    parsed: parsed?.score ?? null,
    dera: dera?.score ?? null,
    parsedCoverage: parsed?.coverage ?? null,
    deraCoverage: dera?.coverage ?? null,
  };
}

// ---------------------------------------------------------------- one quarter

async function ingestQuarter(client, quarter, tickerCiks, totals) {
  const zip = await ensureZip(client, quarter);
  if (!zip) {
    log(`${quarter}: not published yet`);
    return;
  }
  const subs = (await readSubmissions(zip)).filter((s) => DERA_FORMS.includes(s.form.toUpperCase()) && (ONLY_CIK ? s.cik === ONLY_CIK : tickerCiks.has(s.cik)));
  if (!subs.length) {
    log(`${quarter}: no submission of a listed company in the forms this keeps`);
    return;
  }

  // What EDGAR says is only needed for the submissions still in play, and
  // the store answers "already have it" without a single request - so that
  // question comes first.
  const stats = {
    candidates: subs.length,
    haveIt: 0,
    inline: 0,
    notOnEdgar: 0,
    noStatements: 0,
    saved: 0,
    noCompany: 0,
  };
  const pending = subs.filter((s) => store.hasFiling(s.adsh) === COMPARE);
  stats.haveIt = COMPARE ? 0 : subs.length - pending.length;
  if (!pending.length) {
    log(`${quarter}: nothing to do (all ${n(subs.length)} ${COMPARE ? 'unsaved' : 'already saved'})`);
    return;
  }
  const ciks = [...new Set(pending.map((s) => s.cik))].sort((a, b) => a - b);
  log(`${quarter}: ${n(pending.length)} of ${n(subs.length)} submissions still open, from ${n(ciks.length)} companies; reading EDGAR's filing lists …`);
  const edgar = await edgarIndex(client, ciks, stats);

  const todo = new Map();
  for (const s of pending) {
    const f = edgar.byAccession.get(s.adsh);
    if (!f) {
      stats.notOnEdgar++;
      continue;
    }
    // a filing EDGAR marks Inline XBRL is the crawler's: it reads the
    // document itself and keeps what the dataset cannot carry
    if (!COMPARE && f.isInlineXBRL && !INCLUDE_INLINE) {
      stats.inline++;
      continue;
    }
    todo.set(s.adsh, s);
  }
  if (!todo.size) {
    log(`${quarter}: nothing to do (${n(stats.haveIt)} already saved, ${n(stats.inline)} left to the crawler, ${n(stats.notOnEdgar)} not on EDGAR)`);
    return;
  }

  log(`${quarter}: ${n(todo.size)} filings to ${COMPARE ? 'compare' : 'rebuild'}; reading the dataset …`);
  const tags = await readTags(zip);
  const tagOf = (tag, version) => tags.get(`${tag}/${version}`) || null;

  const diffs = [];
  const accessions = [...todo.keys()];
  for (let i = 0; i < accessions.length; i += BATCH) {
    const batch = accessions.slice(i, i + BATCH);
    if (accessions.length > BATCH) log(`${quarter}: pass ${i / BATCH + 1} of ${Math.ceil(accessions.length / BATCH)} (${n(batch.length)} filings)`);
    for await (const rows of filingRows(zip, batch)) {
      const sub = todo.get(rows.adsh);
      if (!sub) continue;
      if (COMPARE) {
        const d = await compareOne(sub, rows, edgar, tagOf, quarter);
        if (d) diffs.push(d);
        continue;
      }
      const filing = edgar.byAccession.get(rows.adsh);
      const built = deraResult({
        filing,
        sub,
        pre: rows.pre,
        num: rows.num,
        tagOf,
        snap: edgar.snapByCik.get(sub.cik),
        dataset: quarter,
      });
      if (!built) {
        stats.noStatements++;
        continue;
      }
      if (!DRY) store.putFiling(rows.adsh, sub.cik, built, SCRAPE_VERSION);
      stats.saved++;
      if (LIMIT && stats.saved >= LIMIT) break;
    }
    if (LIMIT && stats.saved >= LIMIT) break;
  }

  if (COMPARE) {
    reportComparison(quarter, diffs);
    return;
  }
  for (const [k, v] of Object.entries(stats)) totals[k] = (totals[k] || 0) + v;
  log(
    `${quarter}: saved ${n(stats.saved)}${DRY ? ' (dry run: nothing written)' : ''}` +
      ` · ${n(stats.haveIt)} already here · ${n(stats.inline)} inline (the crawler's)` +
      `${stats.notOnEdgar ? ` · ${n(stats.notOnEdgar)} not in EDGAR's list` : ''}` +
      `${stats.noStatements ? ` · ${n(stats.noStatements)} with no statements in the dataset` : ''}` +
      ` (${secs()} s)`,
  );
  if (!KEEP) fs.rmSync(zip, { force: true });
}

function reportComparison(quarter, diffs) {
  const built = diffs.filter((d) => d.built);
  const both = built.filter((d) => d.parsed != null && d.dera != null);
  const gaps = both.map((d) => d.dera - d.parsed).sort((a, b) => a - b);
  const pct = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor((gaps.length - 1) * p))] : null);
  const within = (k) => (gaps.length ? ((gaps.filter((g) => Math.abs(g) <= k).length / gaps.length) * 100).toFixed(1) : '—');
  log(`${quarter}: compared ${n(diffs.length)} filings the crawler had already parsed`);
  log(`  rebuilt from the dataset: ${n(built.length)} · no statements in it: ${n(diffs.length - built.length)}`);
  log(
    `  both scored: ${n(both.length)} · only the parse scored: ${n(built.filter((d) => d.parsed != null && d.dera == null).length)} · only the rebuild: ${n(built.filter((d) => d.parsed == null && d.dera != null).length)}`,
  );
  if (gaps.length) {
    log(`  score difference (rebuild − parse): median ${pct(0.5)}, p10 ${pct(0.1)}, p90 ${pct(0.9)}, worst ${gaps[0]} / ${gaps.at(-1)}`);
    log(`  identical ${within(0)}% · within 2 points ${within(2)}% · within 5 ${within(5)}% · within 10 ${within(10)}%`);
  }
  const worst = [...both].sort((a, b) => Math.abs(b.dera - b.parsed) - Math.abs(a.dera - a.parsed)).slice(0, 8);
  for (const d of worst) log(`    ${d.accession} CIK ${d.cik}: parse ${d.parsed} (coverage ${d.parsedCoverage}) → rebuild ${d.dera} (coverage ${d.deraCoverage})`);
}

// --------------------------------------------------------------------- main

openStore();
requireVersion(SCRAPE_VERSION);

const client = new SecClient();
let tickers = savedTickers()?.value;
if (!tickers?.length) tickers = await refreshTickers(client);
const tickerCiks = new Set(tickers.map((t) => t.cik));
log(`${n(tickerCiks.size)} listed companies on EDGAR's ticker table; the store has ${n(store.filingCount())} filings`);

const to = opt('--quarter') || opt('--to') || quarterOf(new Date());
const from = opt('--quarter') || opt('--from') || FIRST;
const list = quarters(from, to);
log(`${list.length} quarters to walk, ${list[0]} back to ${list.at(-1)}${INCLUDE_INLINE ? ' (--include-inline: Inline XBRL filings too)' : ''}`);

const totals = {};
for (const quarter of list) {
  try {
    await ingestQuarter(client, quarter, tickerCiks, totals);
  } catch (err) {
    console.warn(`ingest-dera: ${quarter} failed: ${err.message}`);
  }
  if (LIMIT && (totals.saved || 0) >= LIMIT) break;
}

if (!COMPARE) {
  const size = store.size();
  log(`done in ${secs()} s: saved ${n(totals.saved || 0)} filings${DRY ? ' (dry run)' : ''}, skipped ${n(totals.haveIt || 0)} already here and ${n(totals.inline || 0)} the crawler can parse itself`);
  log(`the store now holds ${n(size.filings)} filings (${(size.filingsBytes / 1048576).toFixed(0)} MB) and ${n(size.scores)} scores`);
  if (!DRY) log('next: `npm run rescore` to score what was added, then `npm run data:push`');
}
process.exit(0);
