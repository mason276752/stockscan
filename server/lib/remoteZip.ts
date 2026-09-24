// Pull single members out of a zip without a zip library. For an archive on
// sec.gov the central directory is read from the tail of the file with a
// Range request and then only the bytes of the wanted entries are fetched -
// the Financial Statement Data Sets are ~60 MB but sub.txt is < 1 MB. The
// same walker also serves zips already held in memory.

import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const TAIL = 65_536 + 22; // max zip comment + EOCD record

// The central directory, as { name, method, compressedSize, localOffset }.
// read(from, to) -> Buffer of those bytes (inclusive)
async function centralDirectory(read, size, names, url) {
  const tail = await read(Math.max(0, size - TAIL), size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`Not a zip file: ${url}`);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error(`zip64 archives are not supported: ${url}`);

  const cd = await read(cdOffset, cdOffset + cdSize - 1);
  const wanted = names ? new Set(names) : null;
  const out = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CD_SIG) {
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted || wanted.has(name)) out.push({ name, method, compressedSize, localOffset });
  }
  return out;
}

// where an entry's bytes start: the local header is 30 fixed bytes plus its
// own name and extra lengths (which need not match the central directory's)
async function dataStartOf(read, entry) {
  const local = await read(entry.localOffset, entry.localOffset + 29);
  return entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
}

const inflate = (method, data, name, url) => {
  if (method === 8) return zlib.inflateRawSync(data);
  if (method === 0) return data;
  throw new Error(`Unsupported zip compression method ${method} for ${name} in ${url}`);
};

async function extract(read, size, names, url) {
  const out = {};
  for (const entry of await centralDirectory(read, size, names, url)) {
    const start = await dataStartOf(read, entry);
    out[entry.name] = inflate(entry.method, await read(start, start + entry.compressedSize - 1), entry.name, url);
  }
  return out;
}

export async function readZipEntries(client, url, names, { priority } = {}) {
  const { size } = await client.head(url, { priority });
  if (!size) throw new Error(`No Content-Length for ${url}`);
  return extract((from, to) => client.buffer(url, { priority, range: [from, to] }), size, names, url);
}

export async function readZipEntry(client, url, name, opts) {
  const entries = await readZipEntries(client, url, [name], opts);
  if (!entries[name]) throw new Error(`${name} not found in ${url}`);
  return entries[name];
}

// All (or the named) entries of a zip already in memory: { name: Buffer }.
export function unzipBuffer(buf, names = null) {
  return extract(async (from, to) => buf.subarray(from, to + 1), buf.length, names, '<buffer>');
}

// One entry of a zip on disk as a stream. The Financial Statement Data Sets
// hold a 600 MB num.txt inside a 60 MB zip, which must never be inflated
// whole - so only the entry's own bytes are read, straight through
// inflateRaw, and the caller consumes them a line at a time.
export async function zipEntryStream(file, name) {
  const fh = await fs.promises.open(file, 'r');
  let entry;
  let start;
  try {
    const size = (await fh.stat()).size;
    const read = async (from, to) => {
      const buf = Buffer.allocUnsafe(to - from + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, from);
      return buf.subarray(0, bytesRead);
    };
    [entry] = await centralDirectory(read, size, [name], file);
    if (!entry) throw new Error(`${name} not found in ${file}`);
    if (entry.method !== 8 && entry.method !== 0) throw new Error(`Unsupported zip compression method ${entry.method} for ${name} in ${file}`);
    start = await dataStartOf(read, entry);
  } finally {
    await fh.close().catch(() => {});
  }
  const raw = fs.createReadStream(file, { start, end: start + entry.compressedSize - 1 });
  return entry.method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw;
}
