// Background crawl of the latest 10-K / 10-Q filings of every company that
// has a ticker, so the report page opens instantly for any of them and the
// screener can compare each company with its previous period and the same
// period a year earlier.
//
//   1. sweep   walk the browse universe (largest public float first), fetch
//              each company's filing list and save its newest DEPTH filings;
//              companies checked in the last week are skipped, so a restart
//              resumes where it left off
//   2. watch   poll EDGAR's daily form index for new 10-K / 10-Q / 20-F /
//              40-F from those companies and save them as they appear - also
//              every half hour in the middle of a sweep, so today's filings
//              never wait for the sweep to finish
//
// Everything runs at low priority: it waits whenever the user is asking for
// something, and it yields to the neighbour prefetcher.

import { store } from './store.js';
import { getCompany, tickerTable, DEFAULT_FORMS } from './edgar.js';
import { ensureStored } from './scrape.js';
import { getUniverse } from './universe.js';
import { scoreAccession } from './score.js';

const CHECK_TTL = 7 * 24 * 3600 * 1000; // re-sweep a company after this long
const DEPTH = 5; // filings per company: the latest, the previous, and the same quarter a year ago with room to spare
const CHECKED_KEY = `crawl:checked:d${DEPTH}`; // a new depth starts the sweep over
const WATCH_EVERY = 30 * 60 * 1000; // daily-index poll interval
const WATCH_DAYS = 7; // how far back the daily index is read on (re)start
const MAX_FAILS = 3; // give up on a filing that keeps failing to parse
const LOG_EVERY = 10_000; // progress line during the sweep
const DAILY_INDEX = 'https://www.sec.gov/Archives/edgar/daily-index';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FORMS = new Set(DEFAULT_FORMS.map((f) => f.toUpperCase()));

// Today's date in EDGAR's time zone, as YYYY-MM-DD.
function edgarDay(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function dailyIndexUrl(day) {
  const [y, m] = day.split('-').map(Number);
  return `${DAILY_INDEX}/${y}/QTR${Math.ceil(m / 3)}/form.${day.replace(/-/g, '')}.idx`;
}

// form.YYYYMMDD.idx: a header, a dashed line, then
// "Form Type   Company Name   CIK   Date Filed   File Name" separated by runs of spaces.
export function parseDailyIndex(text) {
  const out = [];
  let started = false;
  for (const line of text.split('\n')) {
    if (!started) {
      if (/^-{10,}/.test(line)) started = true;
      continue;
    }
    const m = /^(\S+)\s+(.*?)\s{2,}(\d+)\s+(\d{8})\s+(edgar\/data\/\d+\/(\d{10}-\d{2}-\d{6})\.txt)\s*$/.exec(line);
    if (!m) continue;
    out.push({ form: m[1].toUpperCase(), name: m[2].trim(), cik: Number(m[3]), filed: m[4], accession: m[6] });
  }
  return out;
}

export function createCrawler(client, { prefetcher, enabled = true } = {}) {
  const low = client.lowPriority();
  const state = {
    enabled,
    phase: 'waiting', // waiting | sweep | watch
    round: 0,
    total: 0,
    position: 0,
    saved: 0,
    skipped: 0,
    failed: 0,
    done: 0, // companies whose latest filing is on disk (this sweep)
    current: null,
    startedAt: null,
    lastWatch: null,
    watched: 0, // filings picked up from the daily index
    depth: DEPTH,
    watchLog: [], // the last new filings picked up by the daily index
  };
  const fails = store.getKV('crawl:fails')?.value || {};

  // wait while the user is active or the neighbour prefetcher has work
  async function yieldToUser() {
    while (!client.idle || prefetcher?.status().queued || prefetcher?.status().current) await sleep(1000);
  }

  async function saveLatest(company, filing) {
    if (!filing || store.hasFiling(filing.accession)) return false;
    if ((fails[filing.accession] || 0) >= MAX_FAILS) return false;
    state.current = `${company.tickers?.[0] || company.cik} ${filing.form} ${filing.fiscalYear} ${filing.fiscalPeriod}`;
    try {
      await ensureStored(low, filing, company);
      state.saved++;
      try {
        scoreAccession(filing.accession);
      } catch (err) {
        console.warn(`score ${filing.accession}: ${err.message}`);
      }
      return true;
    } catch (err) {
      state.failed++;
      fails[filing.accession] = (fails[filing.accession] || 0) + 1;
      store.putKV('crawl:fails', fails);
      console.warn(`crawl ${filing.accession} (${company.name}) failed: ${err.message}`);
      return false;
    } finally {
      state.current = null;
    }
  }

  async function sweep() {
    state.phase = 'sweep';
    state.round++;
    const u = await getUniverse(client, { priority: 'low' });
    // the universe is rebuilt weekly; the ticker table daily - a company that
    // was delisted in between is skipped (nothing to buy, nothing to fetch)
    const listed = new Set((await tickerTable(client)).map((t) => t.cik));
    const targets = u.companies.filter((c) => c.ticker && listed.has(c.cik)); // already sorted by public float, largest first
    const checked = store.getKV(CHECKED_KEY)?.value || {};
    state.total = targets.length;
    state.position = 0;
    state.done = 0;
    const timer = setInterval(logProgress, LOG_EVERY);
    for (const c of targets) {
      state.position++;
      if (checked[c.cik] && Date.now() - Date.parse(checked[c.cik]) < CHECK_TTL) {
        state.done++;
        continue;
      }
      await yieldToUser();
      // today's filings must not wait for a multi-hour sweep
      if (!state.lastWatch || Date.now() - Date.parse(state.lastWatch) > WATCH_EVERY) {
        try {
          await watch();
        } catch (err) {
          console.warn(`crawl watch failed: ${err.message}`);
        }
        state.phase = 'sweep';
      }
      try {
        // a list up to a week old is fine here (the daily-index watch adds today's filings):
        // a company whose newest DEPTH filings are all saved costs no request at all
        const company = await getCompany(low, String(c.cik), { maxAge: CHECK_TTL });
        // the newest DEPTH originals (amendments rarely carry full statements)
        const wanted = company.filings.filter((f) => !/\/A$/i.test(f.form || '')).slice(0, DEPTH);
        let had = 0;
        for (const filing of wanted) {
          if (store.hasFiling(filing.accession)) had++;
          else if (await saveLatest(company, filing)) had++;
          else state.skipped++;
        }
        if (!wanted.length || had === wanted.length) state.done++;
      } catch (err) {
        state.failed++;
        console.warn(`crawl ${c.ticker} (CIK ${c.cik}): ${err.message}`);
      }
      checked[c.cik] = new Date().toISOString();
      if (state.position % 25 === 0) store.putKV(CHECKED_KEY, checked);
    }
    store.putKV(CHECKED_KEY, checked);
    clearInterval(timer);
    logProgress();
    console.log(`crawl sweep ${state.round} done: ${state.saved} saved, ${state.skipped} already had, ${state.failed} failed`);
  }

  const n = (x) => x.toLocaleString('en-US');
  function logProgress() {
    const remaining = state.total - state.position;
    console.log(
      `crawl: 已備齊 ${n(state.done)} / ${n(state.total)} 家最近 ${DEPTH} 期財報，還需處理 ${n(remaining)} 家` +
        `（本輪新存 ${n(state.saved)}、失敗 ${n(state.failed)}）${state.current ? ` 目前 ${state.current}` : ''}`,
    );
  }

  // New 10-K / 10-Q … in EDGAR's daily index for companies with a ticker.
  async function watch() {
    const before = state.phase;
    state.phase = 'watch';
    const tickers = await tickerTable(client);
    const known = new Set(tickers.map((t) => t.cik));
    const done = store.getKV('crawl:days')?.value || {}; // day -> true once a past day is fully processed
    const today = edgarDay();
    for (let back = WATCH_DAYS; back >= 0; back--) {
      const day = edgarDay(back);
      if (done[day]) continue;
      let text;
      try {
        text = await low.text(dailyIndexUrl(day));
      } catch (err) {
        // no index for a weekend / holiday: SEC answers 404, or 403 for some paths
        if (err.status === 404 || (err.status === 403 && day < today)) {
          if (day < today) done[day] = true;
          continue;
        }
        console.warn(`daily index ${day}: ${err.message}`);
        continue;
      }
      const rows = parseDailyIndex(text).filter((r) => FORMS.has(r.form) && known.has(r.cik) && !store.hasFiling(r.accession));
      for (const r of rows) {
        await yieldToUser();
        try {
          // the company's cached filing list will not have it yet
          const company = await getCompany(low, String(r.cik), { refresh: true });
          const filing = company.filings.find((f) => f.accession === r.accession);
          if (filing && (await saveLatest(company, filing))) {
            state.watched++;
            state.watchLog.unshift({ at: new Date().toISOString(), day, ticker: company.tickers?.[0] || null, cik: company.cik, form: filing.form, fiscalYear: filing.fiscalYear, fiscalPeriod: filing.fiscalPeriod, filingDate: filing.filingDate });
            state.watchLog.length = Math.min(state.watchLog.length, 50);
            console.log(`crawl: 新申報 ${company.tickers?.[0] || company.cik} ${filing.form} ${filing.fiscalYear} ${filing.fiscalPeriod}（${day} 申報）已下載（已存 ${n(store.filingCount())} 份）`);
          }
        } catch (err) {
          console.warn(`crawl new filing ${r.accession}: ${err.message}`);
        }
      }
      if (day < today) done[day] = true;
    }
    for (const day of Object.keys(done)) if (day < edgarDay(WATCH_DAYS + 7)) delete done[day];
    store.putKV('crawl:days', done);
    state.lastWatch = new Date().toISOString();
    state.lastWatchDay = today;
    if (before === 'sweep') state.phase = 'sweep';
  }

  async function run() {
    state.startedAt = new Date().toISOString();
    for (;;) {
      try {
        await sweep();
      } catch (err) {
        console.warn(`crawl sweep failed: ${err.message}`);
        await sleep(10 * 60 * 1000);
        continue;
      }
      const until = Date.now() + CHECK_TTL;
      while (Date.now() < until) {
        try {
          await watch();
        } catch (err) {
          console.warn(`crawl watch failed: ${err.message}`);
        }
        await sleep(WATCH_EVERY);
      }
    }
  }

  return {
    start() {
      if (enabled) run();
    },
    // one pass over the daily index (the last WATCH_DAYS days), then stop:
    // for a scheduled job that tops the store up with today's filings
    async watchOnce() {
      await watch();
      return { watched: state.watched, failed: state.failed, log: state.watchLog };
    },
    status: () => ({ ...state }),
  };
}
