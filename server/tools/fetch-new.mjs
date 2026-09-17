// Fetch the filings EDGAR's daily index lists for the last few days that are
// not in the store yet (10-K / 10-Q / 20-F / 40-F of companies with a
// ticker), parse, save and score them, then score whatever else is saved
// but unscored (a new score version) - one pass, then exit. The scheduled
// GitHub Actions job runs this and pushes data/store to the data ref (refs/data/main) before publishing the
// static site; it is also handy by hand: SEC_USER_AGENT=… npm run fetch:new
import { SecClient } from '../lib/secClient.js';
import { openStore, requireVersion, store } from '../lib/store.js';
import { SCRAPE_VERSION } from '../lib/scrape.js';
import { createCrawler } from '../lib/crawler.js';
import { refreshTickers, purgeDelisted } from '../lib/edgar.js';
import { scoreUnscored } from '../lib/score.js';

const t0 = Date.now();
const client = new SecClient();
openStore();
requireVersion(SCRAPE_VERSION);
const before = store.filingCount();
const rows = await refreshTickers(client);
console.log(`fetch-new: ticker table ${rows.length}`);
purgeDelisted(rows);
const crawler = createCrawler(client, { enabled: false });
const r = await crawler.watchOnce();
for (const f of r.log) console.log(`fetch-new: ${f.ticker || f.cik} ${f.form} ${f.fiscalYear} ${f.fiscalPeriod} (${f.filingDate})`);
console.log(`fetch-new: ${r.watched} new filings (${r.failed} failed), store ${before} -> ${store.filingCount()}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await scoreUnscored({ budgetMs: 5000, log: (m) => console.log(`fetch-new: ${m}`) });
console.log(`fetch-new: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(0);
