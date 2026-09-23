// Background crawl of the latest 10-K / 10-Q filings of every company that
// has a ticker, so the report page opens instantly for any of them and the
// screener can compare each company with its previous period and the same
// period a year earlier.
//
//   1. sweep    walk the browse universe (largest public float first), fetch
//               each company's filing list and save its newest FIRST_PASS
//               filings, so every company is worth opening within hours of a
//               fresh start; companies checked in the last week are skipped,
//               so a restart resumes where it left off. It is also the safety
//               net: whatever was filed while the server was off falls
//               between the watch window and the backfill cursor, and the
//               next sweep picks it up.
//   2. watch    poll EDGAR's daily form index for new 10-K / 10-Q / 20-F /
//               40-F from those companies and save them as they appear - also
//               every half hour in the middle of a sweep, so today's filings
//               never wait for the sweep to finish
//   3. backfill the rest of the history: the same daily index read backwards,
//               one day per step, for as long as the server runs. Nothing
//               caps how many filings a company ends up with - the store
//               grows towards every Inline XBRL 10-K / 10-Q there is.
//
// Everything runs at low priority: it waits whenever the user is asking for
// something, and it yields to the neighbour prefetcher.

import { store } from './store.js';
import { getCompany, tickerTable, DEFAULT_FORMS } from './edgar.js';
import { filingPeriodKey } from './filings.js';
import { ensureStored } from './scrape.js';
import { getUniverse } from './universe.js';
import { scoreAccession } from './score.js';

const CHECK_TTL = 7 * 24 * 3600 * 1000; // re-sweep a company after this long
// What the sweep grabs per company on its first visit: enough to score it
// and compare it with the previous period and the year before. It is not a
// limit on the store - the backfill keeps adding older filings behind it.
const FIRST_PASS = 5;
const CHECKED_KEY = `crawl:checked:d${FIRST_PASS}`; // a new depth starts the sweep over
const WATCH_EVERY = 30 * 60 * 1000; // daily-index poll interval
const WATCH_DAYS = 7; // how far back the daily index is read normally
// ... and at most, when the server was off for longer than that: the watch
// then reads every day back to the last one it did read, so a gap is filled
// by the daily index rather than left to the next sweep. Beyond this the
// sweep's first pass (the newest filings of every company) is what covers it.
const WATCH_MAX_DAYS = 90;
// The backfill walks the daily index backwards from just before the watch
// window and stops here: EDGAR has daily indexes back to 1994, but Inline
// XBRL (the only thing this parser reads) starts with the 2019 phase-in, so
// earlier days hold nothing to parse. STOCKSCAN_CRAWL_FROM moves the floor
// (a later date keeps the store smaller).
const BACKFILL_FLOOR = (process.env.STOCKSCAN_CRAWL_FROM || '2019-01-01').slice(0, 10);
const BACKFILL_KEY = 'crawl:backfill'; // { day } - the next (older) day to read
const BACKFILL_SUBMISSIONS_TTL = 7 * 24 * 3600 * 1000; // an old day's filings: a filing list from this week will do
const MAX_FAILS = 3; // give up on a filing that keeps failing to parse
const LOG_EVERY = 10_000; // progress line during the sweep
// Companies crawled at the same time. One filing is ~8 short SEC requests
// done one after another, so a single lane spends most of its time waiting
// on the network; a few lanes fill the client's 10 req/s allowance instead.
const LANES = Math.max(1, Number(process.env.STOCKSCAN_CRAWL_PARALLEL) || 4);
const DAILY_INDEX = 'https://www.sec.gov/Archives/edgar/daily-index';

// a company's filings -> every version of its `n` newest periods (an
// amendment shares its original's period, so the two count once)
function newestPeriods(filings, n) {
  const byPeriod = new Map();
  for (const f of filings) {
    const key = filingPeriodKey(f);
    const rec = byPeriod.get(key) || byPeriod.set(key, { end: f.periodEnd || f.reportDate || '', versions: [] }).get(key);
    rec.versions.push(f);
  }
  return [...byPeriod.values()]
    .sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0))
    .slice(0, n)
    .flatMap((r) => r.versions);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FORMS = new Set(DEFAULT_FORMS.map((f) => f.toUpperCase()));

// Today's date in EDGAR's time zone, as YYYY-MM-DD.
function edgarDay(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// YYYY-MM-DD a day earlier, and the number of days between two of them
const prevDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.max(0, Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000));

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
    phase: 'waiting', // waiting | sweep | watch | backfill
    round: 0,
    total: 0,
    position: 0,
    saved: 0,
    skipped: 0,
    failed: 0,
    done: 0, // companies whose latest filing is on disk (this sweep)
    current: null, // the filings being fetched right now
    lanes: LANES,
    startedAt: null,
    lastWatch: null,
    watched: 0, // filings picked up from the daily index
    depth: FIRST_PASS,
    watchLog: [], // the last new filings picked up by the daily index
    // the walk back through the daily index (phase 'backfill')
    backfill: (() => {
      const day = store.getKV(BACKFILL_KEY)?.value?.day || null;
      return { day, floor: BACKFILL_FLOOR, left: day ? daysBetween(day, BACKFILL_FLOOR) : null, days: 0, saved: 0, done: !!day && day < BACKFILL_FLOOR };
    })(),
  };
  const fails = store.getKV('crawl:fails')?.value || {};
  const inFlight = new Set(); // one label per lane, shown in the status line
  const setCurrent = () => (state.current = inFlight.size ? [...inFlight].join(', ') : null);

  // wait while the user is active or the neighbour prefetcher has work
  async function yieldToUser() {
    while (!client.idle || prefetcher?.status().queued || prefetcher?.status().current) await sleep(1000);
  }

  // score saved filings (a quarter's score needs the quarter before it, so
  // this runs once a company's batch is on disk; one scored without a
  // neighbour earlier is redone now that more may be saved)
  async function scoreSaved(filings) {
    for (const f of filings) {
      if (!store.hasFiling(f.accession)) continue;
      try {
        await scoreAccession(f.accession, { redoPartial: true });
      } catch (err) {
        console.warn(`score ${f.accession}: ${err.message}`);
      }
    }
  }

  async function saveLatest(company, filing) {
    if (!filing || store.hasFiling(filing.accession)) return false;
    if ((fails[filing.accession] || 0) >= MAX_FAILS) return false;
    const label = `${company.tickers?.[0] || company.cik} ${filing.form} ${filing.fiscalYear} ${filing.fiscalPeriod}`;
    inFlight.add(label);
    setCurrent();
    try {
      await ensureStored(low, filing, company);
      state.saved++;
      return true;
    } catch (err) {
      state.failed++;
      fails[filing.accession] = (fails[filing.accession] || 0) + 1;
      store.putKV('crawl:fails', fails);
      console.warn(`crawl ${filing.accession} (${company.name}) failed: ${err.message}`);
      return false;
    } finally {
      inFlight.delete(label);
      setCurrent();
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
    let next = 0; // index of the next company to hand to a lane
    let watching = null; // the daily-index poll in progress (the lanes wait for it)
    const lane = async () => {
      for (;;) {
        const c = targets[next++];
        if (!c) return;
        state.position++;
        if (checked[c.cik] && Date.now() - Date.parse(checked[c.cik]) < CHECK_TTL) {
          state.done++;
          continue;
        }
        await yieldToUser();
        // today's filings must not wait for a multi-hour sweep
        if (!state.lastWatch || Date.now() - Date.parse(state.lastWatch) > WATCH_EVERY) {
          watching ??= watch()
            .catch((err) => console.warn(`crawl watch failed: ${err.message}`))
            .finally(() => {
              watching = null;
              state.phase = 'sweep';
            });
          await watching;
        }
        try {
          const company = await getCompany(low, String(c.cik));
          // the newest FIRST_PASS periods, every version of each: a period
          // that was amended is read as its amendment (filings.js
          // collapseAmendments), so the 10-K/A has to be on disk beside the
          // 10-K - and when the amendment turns out to be Part III only,
          // the original beside it is what answers.
          const wanted = newestPeriods(company.filings, FIRST_PASS);
          let had = 0;
          for (const filing of wanted) {
            if (store.hasFiling(filing.accession)) had++;
            else if (await saveLatest(company, filing)) had++;
            else state.skipped++;
          }
          await scoreSaved(wanted);
          if (!wanted.length || had === wanted.length) state.done++;
        } catch (err) {
          state.failed++;
          console.warn(`crawl ${c.ticker} (CIK ${c.cik}): ${err.message}`);
        }
        checked[c.cik] = new Date().toISOString();
        if (state.position % 25 === 0) store.putKV(CHECKED_KEY, checked);
      }
    };
    await Promise.all(Array.from({ length: LANES }, lane));
    store.putKV(CHECKED_KEY, checked);
    clearInterval(timer);
    logProgress();
    console.log(`crawl sweep ${state.round} done: ${state.saved} saved, ${state.skipped} already had, ${state.failed} failed`);
  }

  const n = (x) => x.toLocaleString('en-US');
  function logProgress() {
    const remaining = state.total - state.position;
    console.log(
      `crawl: 已備齊 ${n(state.done)} / ${n(state.total)} 家最近 ${FIRST_PASS} 期財報，還需處理 ${n(remaining)} 家` +
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
    // the usual few days, or everything since the last day read if the
    // server has been away longer than that
    const newestDone = Object.keys(done).sort().at(-1) || null;
    const days = Math.min(WATCH_MAX_DAYS, Math.max(WATCH_DAYS, newestDone ? daysBetween(today, newestDone) : WATCH_DAYS));
    if (days > WATCH_DAYS) console.log(`crawl: 上次讀 daily index 是 ${newestDone}，這次往回讀 ${days} 天補齊`);
    for (let back = days; back >= 0; back--) {
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
            await scoreSaved([filing]);
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
    for (const day of Object.keys(done)) if (day < edgarDay(WATCH_MAX_DAYS + 7)) delete done[day];
    store.putKV('crawl:days', done);
    state.lastWatch = new Date().toISOString();
    state.lastWatchDay = today;
    if (before === 'sweep' || before === 'backfill') state.phase = before;
  }

  // ---- backfill: the older filings, one EDGAR day at a time ----
  // The same daily index the watch reads, walked backwards from just before
  // the watch window: every 10-K / 10-Q / 20-F / 40-F of a listed company
  // that is not on disk yet is fetched, then the cursor steps back a day and
  // is written to the store, so a restart carries on where it stopped.
  // Returns false when the day could not be read (the caller waits a while)
  // or the floor is reached.
  function backfillCursor() {
    const saved = store.getKV(BACKFILL_KEY)?.value?.day;
    return saved && /^\d{4}-\d{2}-\d{2}$/.test(saved) ? saved : edgarDay(WATCH_DAYS + 1);
  }
  function setCursor(day) {
    store.putKV(BACKFILL_KEY, { day, updatedAt: new Date().toISOString() });
    state.backfill.day = day;
    state.backfill.left = daysBetween(day, BACKFILL_FLOOR);
    state.backfill.done = day < BACKFILL_FLOOR;
  }

  async function backfillDay() {
    const day = backfillCursor();
    state.backfill.day = day;
    state.backfill.left = daysBetween(day, BACKFILL_FLOOR);
    if (day < BACKFILL_FLOOR) {
      state.backfill.done = true;
      return false;
    }
    state.phase = 'backfill';
    await yieldToUser();
    let text;
    try {
      text = await low.text(dailyIndexUrl(day));
    } catch (err) {
      // no index for a weekend / holiday: SEC answers 404, or 403 for some paths
      if (err.status === 404 || err.status === 403) {
        setCursor(prevDay(day));
        return true;
      }
      console.warn(`crawl backfill ${day}: ${err.message}`);
      return false; // a network hiccup: the same day again in a moment
    }
    const known = new Set((await tickerTable(client)).map((t) => t.cik));
    const rows = parseDailyIndex(text).filter((r) => FORMS.has(r.form) && known.has(r.cik) && !store.hasFiling(r.accession));
    // one filing list serves every filing a company sent that day
    const byCik = new Map();
    for (const r of rows) (byCik.get(r.cik) || byCik.set(r.cik, []).get(r.cik)).push(r.accession);
    let saved = 0;
    for (const [cik, accessions] of byCik) {
      await yieldToUser();
      try {
        // no refresh: a list from this week already has a filing this old
        const company = await getCompany(low, String(cik), { maxAge: BACKFILL_SUBMISSIONS_TTL });
        const got = [];
        for (const acc of accessions) {
          const filing = company.filings.find((f) => f.accession === acc); // absent = not Inline XBRL, nothing to parse
          if (filing && (await saveLatest(company, filing))) got.push(filing);
        }
        if (!got.length) continue;
        saved += got.length;
        // the filing right after each of these was scored without them (a
        // quarter's score reads the quarter before it): redo those as well
        const redo = new Map(got.map((f) => [f.accession, f]));
        for (const f of got) {
          const i = company.filings.indexOf(f); // newest first
          if (i > 0) redo.set(company.filings[i - 1].accession, company.filings[i - 1]);
        }
        await scoreSaved([...redo.values()]);
      } catch (err) {
        state.failed++;
        console.warn(`crawl backfill ${day} CIK ${cik}: ${err.message}`);
      }
    }
    state.backfill.days++;
    state.backfill.saved += saved;
    setCursor(prevDay(day));
    if (rows.length) console.log(`crawl 補舊財報 ${day}：${n(rows.length)} 份待補、新存 ${n(saved)} 份（共 ${n(store.filingCount())} 份，往回補到 ${BACKFILL_FLOOR} 還有 ${n(state.backfill.left)} 天）`);
    return true;
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
      // until the next sweep: watch for today's filings every WATCH_EVERY and
      // spend the time in between walking the daily index backwards
      const until = Date.now() + CHECK_TTL;
      while (Date.now() < until) {
        try {
          await watch();
        } catch (err) {
          console.warn(`crawl watch failed: ${err.message}`);
        }
        const nextWatch = Date.now() + WATCH_EVERY;
        while (Date.now() < nextWatch && Date.now() < until) {
          let moved = false;
          try {
            moved = await backfillDay();
          } catch (err) {
            console.warn(`crawl backfill failed: ${err.message}`);
          }
          // nothing to do (the floor is reached, or the day would not load):
          // idle until the next watch
          if (!moved) await sleep(Math.max(1000, Math.min(60_000, nextWatch - Date.now())));
        }
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
    // one step back through the daily index: for a scheduled job that fills
    // in history a few days at a time. Returns false once the floor is reached.
    backfillOnce() {
      return backfillDay();
    },
    status: () => ({ ...state }),
  };
}
