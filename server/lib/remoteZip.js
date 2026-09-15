// Pull single members out of a zip without a zip library. For an archive on
// sec.gov the central directory is read from the tail of the file with a
// Range request and then only the bytes of the wanted entries are fetched -
// the Financial Statement Data Sets are ~60 MB but sub.txt is < 1 MB. The
// same walker also serves zips already held in memory.

import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const TAIL = 65_536 + 22; // max zip comment + EOCD record

// read(from, to) -> Buffer of those bytes (inclusive)
async function extract(read, size, names, url) {
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
  const out = {};
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
    if (wanted && !wanted.has(name)) continue;
    // local header: 30 fixed bytes + its own name/extra lengths
    const local = await read(localOffset, localOffset + 29);
    const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const data = await read(dataStart, dataStart + compressedSize - 1);
    if (method === 8) out[name] = zlib.inflateRawSync(data);
    else if (method === 0) out[name] = data;
    else throw new Error(`Unsupported zip compression method ${method} for ${name} in ${url}`);
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
