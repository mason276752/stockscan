// What leaves this machine.
//
// The local store is the master copy: the crawler keeps walking backwards
// through EDGAR for as long as the server runs, so it grows towards every
// Inline XBRL filing there is (~170,000 back to 2019, a few GB). The two
// copies that travel cannot take that:
//
//   data ref (refs/data/main)  git has to move it around, and every commit
//                              keeps what it held for ever - blobs that go
//                              up never come back down
//   the published site         GitHub Pages allows 1 GB in total, and the
//                              bars and indexes want their share of it
//
// So both carry the filings of the last PUBLISH_YEARS years only. What they
// do keep in full is the *scores* (data ref) - a score is ~60x smaller than
// the filing it was computed from, and it is what the screener's time
// machine reads, so a date can still reach back as far as the crawler ever
// got even where the statements behind it are no longer published.
//
// The filings left behind are not lost: they are on the machine that
// crawled them, and anything else can fetch them from EDGAR again. But that
// machine is their only copy - a parse or score version bump can only be
// redone in full there.

// The data ref takes everything: every filing the crawler ever saved goes
// up, so GitHub holds the whole history. (A filing file is written once and
// never touched again, so the same blob is shared by every commit - history
// costs nothing for them. What history does cost is the files that change:
// the company records, the ticker table, the universe.) STOCKSCAN_PUBLISH_YEARS
// is there for whoever wants to keep the ref small anyway - unset, nothing
// is held back.
export const PUBLISH_YEARS = Number(process.env.STOCKSCAN_PUBLISH_YEARS) || null;

// The site cannot take everything: a GitHub Pages site may be 1 GB, full
// stop. So the newest filings that fit go up and the older ones do not -
// they stay one hop away, at raw.githubusercontent.com on the data ref.
// STOCKSCAN_PUBLISH_MB overrides the budget; by default the build works out
// what is left once the bars, the indexes and the app have taken theirs.
export const PAGES_LIMIT_MB = 1024;
export const publishMb = (reservedMb = 0) => Math.round(Number(process.env.STOCKSCAN_PUBLISH_MB) || Math.max(50, PAGES_LIMIT_MB - reservedMb - 40));

// the newest filings that fit in `mb`, as a Set of accessions plus where
// they stop (`from`: the period end of the oldest one that made it)
export function publishBudget(filings, mb) {
  const sorted = filings.filter((f) => f.reportDate).sort((a, b) => (a.reportDate < b.reportDate ? 1 : a.reportDate > b.reportDate ? -1 : 0));
  const limit = mb * 1048576;
  const accessions = new Set();
  let bytes = 0;
  let from = null;
  for (const f of sorted) {
    const size = f.bytes || 10 * 1024;
    if (bytes + size > limit) break;
    bytes += size;
    accessions.add(f.accession);
    from = f.reportDate;
  }
  return { accessions, bytes, from, left: filings.length - accessions.size };
}

// the oldest period end that travels, as YYYY-MM-DD (null = no limit)
export function publishFrom(years = PUBLISH_YEARS, now = Date.now()) {
  if (!years) return null;
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

// A saved filing / score is named <accession>__<period end>__…__v<n>.json.zst,
// so the period it covers is in the file name - no need to open it.
export const periodEndOf = (file) => /__(\d{4}-\d{2}-\d{2})__/.exec(file)?.[1] || null;

// does this filing / score travel? (`reportDate` from the store index, else
// the file name; one without a date never does - nothing can place it)
export const inWindow = (rec, from) => {
  if (!from) return true; // no window: everything travels
  const end = rec.reportDate || periodEndOf(String(rec.file || rec));
  return !!end && end >= from;
};
