// Bring every ticker's TradingView daily bars up to date - one pass, then
// exit. The scheduled GitHub Actions job runs this before building the static
// site: the checkout has the finished years (data/bars/**/<year>.zst, in git);
// this fetches the running year (head.zst, not in git - kept between runs by
// actions/cache) so the published site has bars to today. By hand:
// npm run fetch:bars. Needs TradingView (TV_ENABLED not 0).
import { SecClient } from '../lib/secClient.js';
import { openStore } from '../lib/store.js';
import { barStore, openBarStore } from '../lib/barStore.js';
import { createBarCrawler } from '../lib/barCrawler.js';

const t0 = Date.now();
const client = new SecClient();
openStore();
openBarStore();
const before = barStore.stats();
const crawler = createBarCrawler(client);
if (!crawler.status().enabled) {
  console.log('fetch-bars: TradingView disabled (TV_ENABLED=0) - nothing to do');
  process.exit(0);
}
const r = await crawler.runOnce();
const after = barStore.stats();
console.log(`fetch-bars: ${r.total} symbols, ${r.fetched} updated (${r.bars} bars), ${r.fresh} fresh, ${r.failed} failed; ${(before.bytes / 1048576).toFixed(0)} -> ${(after.bytes / 1048576).toFixed(0)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(r.fetched + r.fresh > 0 ? 0 : 1);
