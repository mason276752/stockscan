<script setup>
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue';
import { api } from './api';
import CompanySearch from './components/CompanySearch.vue';
import FilingPicker from './components/FilingPicker.vue';
import StatementTable from './components/StatementTable.vue';
import IndicatorsTable from './components/IndicatorsTable.vue';
import ValuationPanel from './components/ValuationPanel.vue';
import TvEmbedChart from './components/TvEmbedChart.vue';
import { simplifyStatement } from '../../shared/simplify.js';
import BrowsePage from './components/BrowsePage.vue';
import WatchlistPage from './components/WatchlistPage.vue';
import ScreenerPage from './components/ScreenerPage.vue';
// the custom-ETF page brings its charting library along: loaded when first opened
const BasketPage = defineAsyncComponent(() => import('./components/BasketPage.vue'));
import ScoreCard from './components/ScoreCard.vue';
import Note from './components/Note.vue';
import Loading from './components/Loading.vue';
import { busy, download } from './busy';
import { THEMES, theme } from './theme';
import { isPhone } from './viewport';
import { drop, prefetch, setBusy } from './prefetch';
import { memoize } from './memo';
import { isWatched, toggleWatch, watchlist } from './watchlist';
import { baskets } from './baskets';
import { bigMoney, dateLocale, isZh, locale, LOCALES, pick, t } from './i18n';

// background crawl progress (server-side), shown in the header
const status = ref(null);
async function pollStatus() {
  try {
    status.value = await api.status();
  } catch {
    status.value = null;
  }
}
const isStatic = api.isStatic;
const crawlText = computed(() => {
  if (status.value?.static) {
    const m = status.value.meta;
    return t('crawl.static', { n: Number(m.filings || 0).toLocaleString(), date: m.builtAt ? new Date(m.builtAt).toLocaleDateString(dateLocale.value) : '—' });
  }
  const c = status.value?.crawler;
  if (!c?.enabled) return '';
  const saved = status.value.store.filings.toLocaleString();
  const watchNote = c.lastWatch ? t('crawl.watchNote', { time: new Date(c.lastWatch).toLocaleTimeString(dateLocale.value), watched: c.watched ? t('crawl.watched', { n: c.watched }) : '' }) : '';
  if (c.phase === 'sweep') return t('crawl.sweep', { depth: c.depth || 5, position: c.position.toLocaleString(), total: c.total.toLocaleString(), current: c.current ? ` · ${c.current}` : '', saved, watch: watchNote });
  const b = c.backfill;
  if (c.phase === 'backfill' && b?.day) return t(b.done ? 'crawl.backfillDone' : 'crawl.backfill', { day: b.day, floor: b.floor, left: Number(b.left || 0).toLocaleString(), current: c.current ? ` · ${c.current}` : '', saved, watch: watchNote });
  if (c.phase === 'watch') return t('crawl.watch', { saved, watch: watchNote });
  return '';
});

// page: 'report' (statements of one company) | 'browse' (industry / filer status / ETF lists) | 'watch' (watchlist)
//       | 'screen' (screener) | 'basket' (custom ETF charts)
const page = ref('report');
const browseParams = ref({});
const screenParams = ref({}); // the screener's filters, mirrored in the URL

// the per-company requests, memoized so an idle prefetch (see planPrefetch)
// and the click that follows share one request
const cached = {
  filing: memoize((cik, accession, view) => api.filing(cik, accession, view), 24),
  quarters: memoize((id, year) => api.quarters(id, year), 8),
  indicators: memoize((id, p) => api.indicators(id, p), 24),
  valuation: memoize((id, p) => api.valuation(id, p), 24),
  score: memoize((cik, accession) => api.score(cik, accession), 60),
  tvSymbol: memoize((ticker) => api.tvSymbol(ticker), 60),
};

const company = ref(null);
const filing = ref(null); // the filing row picked from the list
const data = ref(null); // scraped statements JSON
const loadingCompany = ref(false);
const refreshing = ref(false);
const refreshMessage = ref('');

// Re-read the filing list from SEC (bypassing the 10-minute cache) - for the
// day a new 10-Q / 10-K comes out.
async function refreshFilings() {
  if (!company.value || refreshing.value) return;
  refreshing.value = true;
  refreshMessage.value = '';
  try {
    const before = new Set(company.value.filings.map((f) => f.accession));
    const fresh = await api.company(String(company.value.cik), { refresh: true });
    const added = fresh.filings.filter((f) => !before.has(f.accession));
    company.value = fresh;
    refreshMessage.value = added.length
      ? t('refresh.added', { n: added.length, list: added.map((f) => `${f.form} ${f.fiscalYear} ${f.fiscalPeriod}`).join(t('sep')) })
      : t('refresh.none', { time: new Date(fresh.filingsUpdatedAt).toLocaleTimeString(dateLocale.value) });
    if (added.length && !filing.value?.quartersYear) await loadFiling(added[0]);
  } catch (e) {
    refreshMessage.value = t('refresh.failed', { msg: e.message });
  } finally {
    refreshing.value = false;
  }
}
const loadingFiling = ref(false);
const error = ref(null);
// phones: the filing picker folds away once a filing is chosen, so the statements start near the top
const pickerOpen = ref(true);
watch(filing, (f) => {
  if (f && isPhone.value) pickerOpen.value = false;
});

const tab = ref('balance_sheet');
const divisor = ref(1e6);
const applyNegation = ref(false);
const showConcept = ref(false);
// simple = the four primary statements show only their total columns; member
// breakdowns (equity components, share classes, product lines) are hidden and
// rolled up where the filer tagged a line only per member
const simple = ref(localStorage.getItem('stockscan.simple') !== '0');
watch(simple, (v) => localStorage.setItem('stockscan.simple', v ? '1' : '0'));
const view = ref('current'); // current = only the filing's own period | all = every column in the filing

// financial indicators page
const indicators = ref(null);
const loadingIndicators = ref(false);
const indicatorsError = ref(null);
const indBasis = ref('x4'); // x4 | ttm
const indMode = ref('quarter'); // quarter | year
const indCountQ = ref(20);
const indCountY = ref(5);
const indCount = computed(() => (indMode.value === 'quarter' ? indCountQ.value : indCountY.value));
const indAnnualizeAmounts = ref(true);
const indicatorsParams = computed(() => {
  if (!company.value || !filing.value) return null;
  const period = filing.value.quartersYear ? 'Q4' : filing.value.fiscalPeriod;
  return { year: filing.value.fiscalYear, period, n: indCount.value, basis: indBasis.value, mode: indMode.value };
});
const indicatorsEnd = computed(() => {
  const p = indicatorsParams.value;
  if (!p) return '';
  return indicators.value?.quarterly === false ? `FY${p.year}` : `${p.year} ${p.period}`;
});

async function loadIndicators() {
  const p = indicatorsParams.value;
  if (!p) return;
  loadingIndicators.value = true;
  indicatorsError.value = null;
  try {
    indicators.value = await cached.indicators(String(company.value.cik), p);
  } catch (e) {
    indicatorsError.value = e.message;
    indicators.value = null;
  } finally {
    loadingIndicators.value = false;
  }
}

// valuation page (relative multiples over N quarters + absolute models)
const valuation = ref(null);
const loadingValuation = ref(false);
const valuationError = ref(null);
const valCount = ref(20);
const valAdr = ref(1); // ADR ratio for foreign filers (ordinary shares per listed share)
const valuationParams = computed(() => {
  if (!company.value || !filing.value) return null;
  const period = filing.value.quartersYear ? 'Q4' : filing.value.fiscalPeriod;
  return { year: filing.value.fiscalYear, period, n: valCount.value, ...(valAdr.value !== 1 ? { adr: valAdr.value } : {}) };
});
watch(company, () => (valAdr.value = 1));
async function loadValuation() {
  const p = valuationParams.value;
  if (!p) return;
  loadingValuation.value = true;
  valuationError.value = null;
  try {
    valuation.value = await cached.valuation(String(company.value.cik), p);
  } catch (e) {
    valuationError.value = e.message;
    valuation.value = null;
  } finally {
    loadingValuation.value = false;
  }
}
watch([tab, valuationParams], ([t, p], [, prev]) => {
  if (t !== 'valuation' || !p) return;
  if (valuation.value && JSON.stringify(p) === JSON.stringify(prev) && !valuationError.value) return;
  loadValuation();
});
const isValuation = computed(() => tab.value === 'valuation');

// K-line tab: TradingView's own chart of this one stock (its data, its
// indicators); the exchange-qualified symbol comes from the market snapshot
// so a bare ticker cannot resolve to another country's listing
const isChart = computed(() => tab.value === 'chart');
const tvSymbol = ref(null);
const chartRange = ref(localStorage.getItem('stockscan.krange') || '12M');
const chartColors = ref(localStorage.getItem('stockscan.kcolors') || 'tw');
watch(chartRange, (v) => localStorage.setItem('stockscan.krange', v));
watch(chartColors, (v) => localStorage.setItem('stockscan.kcolors', v));
watch(
  [tab, company],
  async ([t, c]) => {
    if (t !== 'chart' || !c) return;
    const ticker = c.tickers?.[0];
    if (!ticker) {
      tvSymbol.value = { ticker: null, symbol: null };
      return;
    }
    if (tvSymbol.value?.ticker === ticker) return;
    tvSymbol.value = null;
    try {
      const r = await cached.tvSymbol(ticker);
      if (company.value === c) tvSymbol.value = r;
    } catch {
      if (company.value === c) tvSymbol.value = { ticker, symbol: ticker.replace(/-/g, '.'), known: false };
    }
  },
  { immediate: true },
);

watch([tab, indicatorsParams], ([t, p], [, prev]) => {
  if (t !== 'indicators' || !p) return;
  if (indicators.value && JSON.stringify(p) === JSON.stringify(prev) && !indicatorsError.value) return;
  loadIndicators();
});

const TABS = ['balance_sheet', 'income_statement', 'cash_flow', 'equity'];
const isIndicators = computed(() => tab.value === 'indicators');

// score of the selected filing, shown on the indicators tab
const filingScore = ref(null);
watch(
  [tab, filing],
  async ([t, f]) => {
    if (t !== 'indicators' || !f || f.quartersYear) {
      if (f?.quartersYear) filingScore.value = null;
      return;
    }
    if (filingScore.value?.accession === f.accession) return;
    filingScore.value = null;
    try {
      filingScore.value = await cached.score(f.cik, f.accession);
    } catch {
      filingScore.value = null;
    }
  },
  { immediate: true },
);

const otherStatements = computed(() => {
  if (!data.value) return [];
  const primary = new Set(Object.values(data.value.statements).filter(Boolean).map((s) => s.role));
  return data.value.allStatements.filter((s) => !primary.has(s.role));
});

const current = computed(() => {
  if (!data.value) return null;
  if (tab.value.startsWith('role:')) return otherStatements.value.find((s) => s.role === tab.value.slice(5)) || null;
  const stmt = data.value.statements[tab.value];
  return simple.value ? simplifyStatement(stmt) : stmt;
});

function openBrowse(params) {
  browseParams.value = { cat: 'sic', code: '', afs: '', etf: '', ...params };
  page.value = 'browse';
}
const fmtFloat = (v) => `${bigMoney(v)} ${t('usd')}`;

// From the search box or a browse list: show the statements page for that company.
function openCompany(idOrRow) {
  const id = typeof idOrRow === 'string' ? idOrRow : idOrRow.ticker || String(idOrRow.cik);
  page.value = 'report';
  loadCompany(id);
}

async function loadCompany(id, accession = null, quartersYear = null) {
  error.value = null;
  loadingCompany.value = true;
  data.value = null;
  filing.value = null;
  try {
    company.value = await api.company(id);
    if (quartersYear) return await loadQuarters(quartersYear);
    const pick = (accession && company.value.filings.find((f) => f.accession === accession)) || company.value.filings[0];
    if (pick) await loadFiling(pick);
  } catch (e) {
    error.value = e.message;
    company.value = null;
  } finally {
    loadingCompany.value = false;
  }
}

async function loadFiling(f) {
  error.value = null;
  loadingFiling.value = true;
  filing.value = f;
  try {
    data.value = await cached.filing(f.cik, f.accession, view.value);
    const valid = tab.value.startsWith('role:')
      ? data.value.allStatements.some((s) => `role:${s.role}` === tab.value)
      : tab.value === 'indicators' || tab.value === 'valuation' || tab.value === 'chart' || !!data.value.statements[tab.value];
    if (!valid) tab.value = 'balance_sheet';
  } catch (e) {
    error.value = e.message;
    data.value = null;
  } finally {
    loadingFiling.value = false;
  }
}

// Q4 derived view: Q1-Q3 from the 10-Qs, FY from the 10-K, Q4 = FY - Q1 - Q2 - Q3.
async function loadQuarters(year) {
  error.value = null;
  loadingFiling.value = true;
  filing.value = { accession: `q4-${year}`, form: 'Q4*', fiscalYear: year, fiscalPeriod: 'Q4', quartersYear: year };
  try {
    data.value = await cached.quarters(String(company.value.cik), year);
    if (!data.value.statements[tab.value] && !tab.value.startsWith('role:') && tab.value !== 'indicators' && tab.value !== 'valuation' && tab.value !== 'chart') tab.value = 'income_statement';
    if (tab.value.startsWith('role:') && !data.value.allStatements.some((s) => `role:${s.role}` === tab.value)) tab.value = 'income_statement';
  } catch (e) {
    error.value = e.message;
    data.value = null;
  } finally {
    loadingFiling.value = false;
  }
}

// ---- idle prefetch ----
// Once a filing is on screen, what a click is likely to ask for next is
// fetched in the background, in this order: the filing's score (indicators
// tab), the indicators with the current settings, the TradingView symbol
// (chart tab), the next three older filings in the picker; the valuation
// only after an 8 s dwell since it needs the price history (the server
// fetches it; the static build reads ten years of bars). The static
// build's indexes are warmed at start-up (api.warmup). All of it waits
// while a real load is in flight.
setBusy(() => busy.count > 0); // any loading indicator on screen: the user is waiting for something
function planPrefetch() {
  drop('company');
  const c = company.value;
  const f = filing.value;
  if (!c || !f || !data.value) return;
  const cik = String(c.cik);
  const tag = 'company';
  if (!f.quartersYear) prefetch(`score:${f.accession}`, () => cached.score(f.cik, f.accession), { tag, priority: 2 });
  const ip = indicatorsParams.value;
  if (ip) prefetch(`ind:${cik}:${JSON.stringify(ip)}`, () => cached.indicators(cik, ip), { tag, priority: 2 });
  if (c.tickers?.[0]) prefetch(`tv:${c.tickers[0]}`, () => cached.tvSymbol(c.tickers[0]), { tag, priority: 2 });
  const i = c.filings.findIndex((x) => x.accession === f.accession);
  for (const nf of c.filings.slice(Math.max(i, 0) + 1, Math.max(i, 0) + 4)) prefetch(`filing:${nf.accession}:${view.value}`, () => cached.filing(nf.cik, nf.accession, view.value), { tag, priority: 1 });
  const vp = valuationParams.value;
  if (vp) prefetch(`val:${cik}:${JSON.stringify(vp)}`, () => cached.valuation(cik, vp), { tag, priority: 1, delay: 8000 });
}
watch([data, indicatorsParams], () => {
  if (!loadingFiling.value) planPrefetch();
});
watch(company, (c, prev) => {
  if (c !== prev) drop('company');
});

const jsonUrl = computed(() => {
  if (!data.value) return '#';
  if (data.value.derived) return api.quartersUrl(String(data.value.filing.cik), data.value.filing.fiscalYear);
  return api.filingUrl(data.value.filing.cik, data.value.filing.accession, view.value);
});

// switching current / all reloads the same filing (fast: both are served from cache)
watch(view, () => {
  if (filing.value && !filing.value.quartersYear) loadFiling(filing.value);
});

// Keep the selection in the URL so a view can be bookmarked / shared. Switching
// between the report and browse pages pushes a history entry so the browser's Back
// button returns to the list you came from.
let lastPage = page.value;
let restoring = false;
let lastScreen = '';
watch([company, filing, tab, indMode, view, page, browseParams, screenParams], () => {
  const p = new URLSearchParams();
  if (page.value === 'browse') {
    p.set('page', 'browse');
    for (const [k, v] of Object.entries(browseParams.value)) if (v) p.set(k, v);
  } else if (page.value === 'screen') {
    p.set('page', 'screen');
    for (const [k, v] of Object.entries(screenParams.value)) if (v !== '' && v != null) p.set(k, v);
  } else if (page.value === 'watch' || page.value === 'basket') {
    p.set('page', page.value);
  } else {
    if (company.value) p.set('company', company.value.tickers[0] || String(company.value.cik));
    if (filing.value?.quartersYear) p.set('quarters', filing.value.quartersYear);
    else if (filing.value) p.set('accession', filing.value.accession);
    if (data.value && tab.value !== 'balance_sheet') p.set('tab', tab.value);
    if (tab.value === 'indicators' && indMode.value !== 'quarter') p.set('mode', indMode.value);
    if (view.value === 'all') p.set('view', 'all');
  }
  const url = p.size ? `?${p}` : location.pathname;
  // a page switch, or a changed screen (each set of filters gets its own history entry), pushes; the rest replaces
  const screenNow = page.value === 'screen' ? JSON.stringify(screenParams.value) : '';
  const screenChanged = page.value === 'screen' && lastPage === 'screen' && screenNow !== lastScreen;
  if ((page.value !== lastPage || screenChanged) && !restoring) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  lastPage = page.value;
  lastScreen = screenNow;
});

// a basket copied from the screener (or a rule ETF, whose filters *are* the
// fund): reopen the screener with its filters, tagged with the basket so
// "update this ETF" / "update the rule" is offered there
function editScreen(basket) {
  const src = basket?.source;
  if (!src || (src.type !== 'screen' && src.type !== 'rule')) return;
  // baskets saved before the URL form was kept only have API params: the screener rebuilds those itself
  screenParams.value = { ...(src.url || {}), basket: basket.id };
  page.value = 'screen';
}

// the nav button: the screener as it was, minus any basket being edited
function openScreen() {
  if (screenParams.value.basket) {
    const { basket, ...rest } = screenParams.value;
    screenParams.value = rest;
  }
  page.value = 'screen';
}

function applyUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get('tab')) tab.value = p.get('tab');
  if (['year', 'same'].includes(p.get('mode'))) indMode.value = p.get('mode');
  if (p.get('view') === 'all') view.value = 'all';
  if (p.get('page') === 'browse') {
    page.value = 'browse';
    browseParams.value = { cat: p.get('cat') || 'sic', code: p.get('code') || '', afs: p.get('afs') || '', etf: p.get('etf') || '' };
    return;
  }
  if (p.get('page') === 'screen') {
    const sp = {};
    for (const [k, v] of p.entries()) if (k !== 'page') sp[k] = v;
    screenParams.value = sp;
    page.value = 'screen';
    return;
  }
  if (['watch', 'basket'].includes(p.get('page'))) {
    page.value = p.get('page');
    return;
  }
  page.value = 'report';
  const id = p.get('company');
  if (id && (!company.value || (!company.value.tickers.includes(id.toUpperCase()) && String(company.value.cik) !== id))) {
    loadCompany(id, p.get('accession'), p.get('quarters') ? Number(p.get('quarters')) : null);
  }
}

onMounted(() => {
  for (const [key, task, priority] of api.warmup()) prefetch(key, task, { tag: 'boot', priority });
  pollStatus();
  setInterval(pollStatus, 15_000);
  applyUrl();
  window.addEventListener('popstate', () => {
    restoring = true;
    applyUrl();
    setTimeout(() => (restoring = false), 0);
  });
});
</script>

<template>
  <div class="app">
    <div v-if="busy.count" class="topbar" :class="{ known: download.total > 0 }" aria-hidden="true"><div v-if="download.total > 0" class="fill" :style="{ width: `${Math.round((100 * download.loaded) / download.total)}%` }"></div></div>
    <header>
      <h1 class="logo">stockscan <span class="muted">{{ t('header.subtitle') }}</span></h1>
      <nav class="nav">
        <button :class="{ active: page === 'report' }" @click="page = 'report'">{{ t('nav.report') }}</button>
        <button :class="{ active: page === 'browse' }" @click="page = 'browse'">{{ t('nav.browse') }}</button>
        <button :class="{ active: page === 'screen' }" @click="openScreen">{{ t('nav.screen') }}</button>
        <button :class="{ active: page === 'watch' }" @click="page = 'watch'">{{ t('nav.watch') }}<span v-if="watchlist.items.length" class="count">{{ watchlist.items.length }}</span></button>
        <button :class="{ active: page === 'basket' }" @click="page = 'basket'">{{ t('nav.basket') }}<span v-if="baskets.items.length" class="count">{{ baskets.items.length }}</span></button>
      </nav>
      <CompanySearch @select="openCompany" />
      <div class="prefs">
        <select v-model="theme" class="lang" :title="t('header.theme')">
          <option v-for="k in THEMES" :key="k" :value="k">{{ t(`theme.${k}`) }}</option>
        </select>
        <select v-model="locale" class="lang" :title="t('header.language')">
          <option v-for="[k, name] in LOCALES" :key="k" :value="k">{{ name }}</option>
        </select>
      </div>
    </header>
    <p v-if="crawlText" class="muted small crawl" :title="t(isStatic ? 'crawl.staticTitle' : 'crawl.title')">{{ crawlText }}</p>

    <BrowsePage v-if="page === 'browse'" :params="browseParams" @open="openCompany" @navigate="browseParams = $event" @basket="page = 'basket'" />
    <WatchlistPage v-else-if="page === 'watch'" @open="openCompany" @basket="page = 'basket'" />
    <ScreenerPage v-else-if="page === 'screen'" :params="screenParams" @open="openCompany" @basket="page = 'basket'" @navigate="screenParams = $event" />
    <BasketPage v-else-if="page === 'basket'" @open="openCompany" @screen="editScreen" />

    <template v-else>
    <p v-if="error" class="error">{{ error }}</p>
    <Loading v-if="loadingCompany" :text="t('loading.company')" />

    <div v-if="company" class="layout">
      <aside class="panel company">
        <h2 class="co-name">
          <button class="star" :class="{ on: isWatched(company.cik) }" :title="isWatched(company.cik) ? t('watch.remove') : t('watch.add')" @click="toggleWatch(company)">{{ isWatched(company.cik) ? '★' : '☆' }}</button>
          {{ company.name }}
        </h2>
        <div class="muted small co-info">
          {{ company.tickers.join(', ') }} · CIK {{ company.cik }}
          <span v-if="company.fiscalYearEnd"> · {{ t('company.fye') }} {{ company.fiscalYearEnd.slice(0, 2) }}/{{ company.fiscalYearEnd.slice(2) }}</span>
          <div v-if="company.sic">
            <a :href="`?page=browse&cat=sic&code=${company.sic}`" :title="t('company.sameIndustry')" @click.prevent="openBrowse({ cat: 'sic', code: String(company.sic) })">
              SIC {{ company.sic }} {{ isZh ? company.sicZh || company.sicDescription : company.sicDescription || company.sicZh }}
            </a>
          </div>
          <div v-if="company.filer?.filerStatus">
            <a :href="`?page=browse&cat=filer&afs=${company.filer.afs}`" :title="t('company.sameFiler')" @click.prevent="openBrowse({ cat: 'filer', afs: company.filer.afs })">{{ pick(company.filer.filerStatus, 'zh', 'label') }}</a><span v-if="company.filer.wksi"> · WKSI</span>
            <span v-if="company.filer.publicFloat != null"> · {{ t('company.publicFloat') }} {{ fmtFloat(company.filer.publicFloat) }}<span v-if="company.filer.publicFloatAdjusted" :title="t('company.floatAdjusted')">*</span>（{{ company.filer.publicFloatDate }}）</span>
          </div>
        </div>
        <h3 class="pick-head" :class="{ fold: isPhone }" @click="isPhone && (pickerOpen = !pickerOpen)">
          <span><span v-if="isPhone" class="caret">{{ pickerOpen ? '▾' : '▸' }}</span> {{ t('filings.pick') }}<span v-if="isPhone && !pickerOpen && filing" class="picked">{{ filing.form }} {{ filing.fiscalYear }} {{ filing.fiscalPeriod }}</span></span>
          <button v-if="!isStatic" class="refresh" :disabled="refreshing" :title="t('filings.refreshTitle')" @click.stop="refreshFilings">
            <Loading v-if="refreshing" inline small :text="t('filings.refreshing')" /><template v-else>{{ t('filings.refresh') }}</template>
          </button>
        </h3>
        <div v-show="!isPhone || pickerOpen" class="pick-body">
          <p v-if="refreshMessage" class="small refresh-msg">{{ refreshMessage }}</p>
          <FilingPicker :filings="company.filings" :selected="filing?.accession" @select="loadFiling" @select-quarters="loadQuarters" />
          <p class="muted small hide-p">{{ t('filings.legend') }}</p>
          <p class="muted small">{{ t(isStatic ? 'filings.builtAt' : 'filings.listTime', { time: new Date(company.filingsUpdatedAt).toLocaleString(dateLocale) }) }}<span v-if="company.filingsStale">{{ t('filings.stale') }}</span></p>
        </div>
      </aside>

      <main>
        <Loading v-if="loadingFiling" :text="t('loading.filing', { form: filing?.form, year: filing?.fiscalYear, period: filing?.fiscalPeriod })" />

        <template v-if="data && !loadingFiling">
          <div class="panel meta">
            <div v-if="data.derived">
              <strong>{{ t('derived.head', { year: data.filing.fiscalYear }) }}</strong>
              · Q4 = FY − Q1 − Q2 − Q3 · {{ t('derived.sources') }}
              <template v-for="(src, p, i) in data.sources" :key="p">
                <span v-if="i">{{ t('sep') }}</span>
                <a :href="src.viewerUrl" target="_blank" rel="noopener">{{ p }} {{ src.form }}</a>
              </template>
            </div>
            <div v-else>
              <strong>{{ data.filing.form }}</strong>
              {{ data.filing.fiscalPeriod === 'FY' ? `FY${data.filing.fiscalYear}` : `FY${data.filing.fiscalYear} ${data.filing.fiscalPeriod}` }} · {{ t('meta.periodEnd') }} {{ data.filing.periodEnd }} · {{ t('meta.filingDate') }} {{ data.filing.filingDate }}
            </div>
            <div class="links">
              <a v-if="!data.derived" :href="data.filing.viewerUrl" target="_blank" rel="noopener">{{ t('meta.secLink') }}</a>
              <a v-if="!isStatic" :href="jsonUrl" target="_blank" rel="noopener">JSON</a>
              <span class="muted small">{{ data.stats.facts }} facts<template v-if="data.stats.contexts"> · {{ data.stats.contexts }} contexts</template></span>
            </div>
          </div>
          <Note v-if="data.view === 'current' && !isIndicators && !isValuation && !isChart">
            {{ t('note.current', { is: data.filing.form?.startsWith('10-Q') ? t('note.currentQ') : t('note.currentFY') }) }}
            <template v-if="data.previous">{{ t('note.previous', { year: data.previous.fiscalYear, period: data.previous.fiscalPeriod }) }}</template>
            <template v-for="n in data.notes.filter((x) => x.code === 'ytdOnly')" :key="n.title"> {{ t('note.ytdOnly', n) }}</template>
            {{ t('note.compare') }}
          </Note>
          <Note v-if="data.derived && !isIndicators && !isValuation && !isChart">{{ t('note.derived') }}</Note>
          <Note v-if="data.source === 'dera' && !isChart">{{ t('note.dera') }}</Note>

          <div class="toolbar">
            <div class="tabs">
              <button v-for="key in TABS" :key="key" :class="{ active: tab === key }" :disabled="!data.statements[key]" @click="tab = key">
                {{ t(`stmt.${key}`) }}
              </button>
              <button :class="{ active: tab === 'indicators' }" @click="tab = 'indicators'">{{ t('tab.indicators') }}</button>
              <button :class="{ active: tab === 'valuation' }" @click="tab = 'valuation'">{{ t('tab.valuation') }}</button>
              <button :class="{ active: tab === 'chart' }" :title="t('tab.chartTitle')" @click="tab = 'chart'">{{ t('tab.chart') }}</button>
              <select v-if="otherStatements.length" :value="tab.startsWith('role:') ? tab : ''" @change="tab = $event.target.value">
                <option value="" disabled>{{ t('tab.other') }}</option>
                <option v-for="s in otherStatements" :key="s.role" :value="`role:${s.role}`">{{ s.title }}</option>
              </select>
            </div>
            <div v-if="isIndicators" class="options">
              <label v-if="indicators?.quarterly !== false">
                {{ t('ind.view') }}
                <select v-model="indMode">
                  <option value="quarter">{{ t('ind.modeQuarter') }}</option>
                  <option value="year">{{ t('ind.modeYear') }}</option>
                  <option value="same">{{ t('ind.modeSame') }}</option>
                </select>
              </label>
              <label v-if="indMode !== 'quarter' || indicators?.quarterly === false">
                {{ t('ind.years') }}
                <select v-model.number="indCountY">
                  <option :value="3">3</option>
                  <option :value="5">5</option>
                  <option :value="8">8</option>
                  <option :value="10">10</option>
                </select>
              </label>
              <label v-else>
                {{ t('ind.quarters') }}
                <select v-model.number="indCountQ">
                  <option :value="8">8</option>
                  <option :value="12">12</option>
                  <option :value="20">20</option>
                  <option :value="40">40</option>
                </select>
              </label>
              <template v-if="indMode !== 'year' && indicators?.quarterly !== false">
                <label>
                  {{ t('ind.annualize') }}
                  <select v-model="indBasis">
                    <option value="x4">{{ t('ind.x4') }}</option>
                    <option value="ttm">{{ t('ind.ttm') }}</option>
                  </select>
                </label>
                <label><input v-model="indAnnualizeAmounts" type="checkbox" /> {{ t('ind.annualizeAmounts') }}</label>
              </template>
            </div>
            <div v-else-if="isValuation" class="options">
              <label>
                {{ valuation?.quarterly === false ? t('ind.years') : t('ind.quarters') }}
                <select v-model.number="valCount">
                  <option :value="8">8</option>
                  <option :value="12">12</option>
                  <option :value="20">20</option>
                  <option :value="40">40</option>
                </select>
              </label>
              <a v-if="valuationParams && !isStatic" :href="api.valuationUrl(String(company.cik), valuationParams)" target="_blank" rel="noopener" class="small">JSON</a>
            </div>
            <div v-else-if="isChart" class="options">
              <label>
                {{ t('chart.range') }}
                <select v-model="chartRange">
                  <option value="1M">{{ t('chart.months', { n: 1 }) }}</option>
                  <option value="3M">{{ t('chart.months', { n: 3 }) }}</option>
                  <option value="6M">{{ t('chart.months', { n: 6 }) }}</option>
                  <option value="12M">{{ t('chart.years', { n: 1 }) }}</option>
                  <option value="36M">{{ t('chart.years', { n: 3 }) }}</option>
                  <option value="61M">{{ t('chart.years', { n: 5 }) }}</option>
                  <option value="120M">{{ t('chart.years', { n: 10 }) }}</option>
                  <option value="ALL">{{ t('chart.all') }}</option>
                </select>
              </label>
              <label>
                {{ t('chart.candles') }}
                <select v-model="chartColors">
                  <option value="tw">{{ t('chart.tw') }}</option>
                  <option value="us">{{ t('chart.us') }}</option>
                </select>
              </label>
              <a v-if="tvSymbol?.symbol" :href="`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol.symbol)}`" target="_blank" rel="noopener" class="small">{{ t('chart.openTv') }}</a>
            </div>
            <div v-else class="options">
              <label v-if="!data.derived">
                {{ t('stmt.columns') }}
                <select v-model="view">
                  <option value="current">{{ t('stmt.viewCurrent') }}</option>
                  <option value="all">{{ t('stmt.viewAll') }}</option>
                </select>
              </label>
              <label>
                {{ t('stmt.unit') }}
                <select v-model.number="divisor">
                  <option :value="1">{{ t('stmt.unitRaw') }}</option>
                  <option :value="1e3">{{ t('stmt.unitK') }}</option>
                  <option :value="1e6">{{ t('stmt.unitM') }}</option>
                  <option :value="1e9">{{ t('stmt.unitB') }}</option>
                </select>
              </label>
              <label><input v-model="simple" type="checkbox" :title="t('stmt.simpleTitle')" /> {{ t('stmt.simple') }}</label>
              <label><input v-model="applyNegation" type="checkbox" /> {{ t('stmt.negation') }}</label>
              <label><input v-model="showConcept" type="checkbox" /> {{ t('stmt.concept') }}</label>
            </div>
          </div>

          <template v-if="isIndicators">
            <ScoreCard v-if="filingScore && !filing?.quartersYear" :score="filingScore" />
            <Loading v-if="loadingIndicators" :text="t('ind.loading', { end: indicatorsEnd, n: indCount, unit: indMode === 'quarter' ? t('ind.periodUnit') : t('ind.yearUnit') })" />
            <p v-else-if="indicatorsError" class="error">{{ indicatorsError }}</p>
            <template v-else-if="indicators">
              <Note>
                <template v-if="indicators.quarterly && indicators.mode === 'year'">{{ t('ind.noteYear', { end: indicatorsEnd, example: indicators.columns.at(-1)?.sublabel || indicators.columns.at(-1)?.label, n: indicators.columns.length }) }}</template>
                <template v-else-if="indicators.quarterly && indicators.mode === 'same'">{{ t('ind.noteSame', { period: indicatorsParams.period, from: indicators.columns[0]?.label, to: indicators.columns.at(-1)?.label, n: indicators.columns.length, basis: indBasis === 'ttm' ? t('ind.ttm') : t('ind.x4') }) }}</template>
                <template v-else-if="indicators.quarterly">{{ t('ind.noteQuarter', { end: indicatorsEnd, n: indicators.columns.length, basis: indBasis === 'ttm' ? t('ind.ttm') : t('ind.x4') }) }}</template>
                <template v-else>{{ t('ind.noteAnnual', { n: indicators.columns.length }) }}</template>
                <a v-if="!isStatic" :href="api.indicatorsUrl(String(company.cik), indicatorsParams)" target="_blank" rel="noopener">JSON</a>
              </Note>
              <IndicatorsTable :data="indicators" :annualize-amounts="indAnnualizeAmounts" />
            </template>
          </template>
          <template v-else-if="isChart">
            <p v-if="!company.tickers?.length" class="muted">{{ t('chart.noTicker') }}</p>
            <Loading v-else-if="!tvSymbol" :text="t('chart.lookup')" />
            <template v-else>
              <Note>
                {{ tvSymbol.symbol }}<template v-if="tvSymbol.exchange"> · {{ tvSymbol.exchange }}</template> · {{ t('chart.embedNote') }}
                <span v-if="tvSymbol.known === false">{{ t('chart.unknown') }}</span>
              </Note>
              <TvEmbedChart :expression="tvSymbol.symbol" :range="chartRange" :colors="chartColors" :height="isPhone ? 400 : 620" volume symbol-change />
            </template>
          </template>
          <template v-else-if="isValuation">
            <Loading v-if="loadingValuation" :text="t('val.loading', { year: valuationParams?.year, period: valuationParams?.period, n: valCount })" />
            <p v-else-if="valuationError" class="error">{{ valuationError }}</p>
            <ValuationPanel v-else-if="valuation" :data="valuation" :adr="valAdr" @update:adr="valAdr = $event" />
          </template>
          <template v-else>
            <StatementTable v-if="current" :statement="current" :divisor="divisor" :apply-negation="applyNegation" :show-concept="showConcept" :lang="locale" />
            <p v-else class="muted">{{ t('stmt.missing') }}</p>
          </template>
        </template>
      </main>
    </div>

    <div v-else-if="!loadingCompany" class="empty muted">
      {{ t('empty.start') }} <a href="?company=GOOGL" @click.prevent="loadCompany('GOOGL')">GOOGL</a>{{ t('sep') }}
      <a href="?company=AAPL" @click.prevent="loadCompany('AAPL')">AAPL</a>{{ t('sep') }}
      <a href="?company=TSM" @click.prevent="loadCompany('TSM')">TSM</a>{{ t('empty.comma') }}
      {{ t('empty.orBrowse') }} <a href="?page=browse" @click.prevent="page = 'browse'">{{ t('nav.browse') }}</a> {{ t('empty.browseTail') }}
      {{ t('empty.orScreen') }} <a href="?page=screen" @click.prevent="page = 'screen'">{{ t('nav.screen') }}</a> {{ t('empty.screenTail') }}
    </div>
    </template>
  </div>
</template>

<style scoped>
.app {
  max-width: 1600px;
  margin: 0 auto;
  padding: 16px 20px 40px;
}
header {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  grid-template-areas: 'logo nav search lang';
  gap: 24px;
  align-items: center;
  margin-bottom: 16px;
}
header .logo {
  grid-area: logo;
}
header .nav {
  grid-area: nav;
}
header :deep(.search) {
  grid-area: search;
}
header .prefs {
  grid-area: lang;
  display: flex;
  gap: 6px;
}
header .lang {
  font: inherit;
  font-size: 13px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}
.nav {
  display: flex;
  gap: 6px;
}
.nav .count {
  margin-left: 5px;
  font-size: 11px;
  background: var(--overlay-soft);
  border-radius: 8px;
  padding: 0 5px;
}
.nav button:not(.active) .count {
  background: var(--accent-soft);
  color: var(--accent);
}
.star {
  border: none;
  background: none;
  padding: 0 4px 0 0;
  font-size: 18px;
  color: var(--muted);
  cursor: pointer;
  vertical-align: -1px;
}
.star.on {
  color: var(--star);
}
.crawl {
  margin: -8px 0 12px;
  text-align: right;
}
h1 {
  font-size: 20px;
  margin: 0;
  white-space: nowrap;
}
h1 .muted {
  font-weight: normal;
  font-size: 14px;
  margin-left: 8px;
}
h2 {
  font-size: 16px;
  margin: 0 0 4px;
}
h3 {
  font-size: 13px;
  margin: 16px 0 8px;
  color: var(--muted);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
h3.fold {
  cursor: pointer;
  margin: 10px 0 6px;
}
h3 .picked {
  margin-left: 8px;
  color: var(--accent);
  font-weight: 600;
}
.refresh {
  font-size: 12px;
  padding: 3px 8px;
}
.refresh-msg {
  color: var(--accent);
  margin: 0 0 8px;
}
.small {
  font-size: 12px;
}
.error {
  color: var(--neg);
  background: var(--neg-soft);
  padding: 8px 12px;
  border-radius: 6px;
}
.layout {
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 16px;
  align-items: start;
}
aside {
  position: sticky;
  top: 16px;
}
main {
  min-width: 0; /* let the statement table scroll inside instead of widening the page */
}
.meta {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 16px;
  margin-bottom: 12px;
}
.links {
  display: flex;
  gap: 16px;
  align-items: center;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.options {
  display: flex;
  gap: 16px;
  align-items: center;
  font-size: 13px;
}
select {
  font: inherit;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}
.note {
  margin: -4px 0 12px;
}
.empty {
  text-align: center;
  padding: 80px 0;
}
@media (max-width: 1100px) {
  header {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'logo lang'
      'nav nav'
      'search search';
    gap: 10px 16px;
  }
  .nav {
    min-width: 0;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: none;
  }
  header :deep(.search) {
    min-width: 0;
  }
  .nav::-webkit-scrollbar {
    display: none;
  }
  .nav button {
    white-space: nowrap;
  }
  .layout {
    grid-template-columns: 1fr;
  }
  aside {
    position: static;
  }
  /* tablets: company facts on the left, the filing picker on the right */
  aside.company {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
    grid-template-rows: auto 1fr;
    column-gap: 24px;
    align-items: start;
  }
  .co-name {
    grid-area: 1 / 1;
  }
  .co-info {
    grid-area: 2 / 1;
  }
  .pick-head {
    grid-area: 1 / 2;
    margin-top: 0;
  }
  .pick-body {
    grid-area: 2 / 2;
  }
}
@media (max-width: 760px) {
  aside.company {
    display: block;
  }
  .app {
    padding: 10px 10px 32px;
  }
  h1 .muted {
    display: none;
  }
  .crawl {
    text-align: left;
    margin: -4px 0 10px;
  }
  .options {
    gap: 8px 12px;
    flex-wrap: wrap;
  }
  .toolbar > * {
    min-width: 0;
    max-width: 100%;
  }
  .tabs {
    width: 100%;
  }
  .tabs select {
    max-width: 100%;
  }
  .meta {
    padding: 8px 12px;
  }
  .links {
    gap: 10px;
  }
  .empty {
    padding: 40px 0;
  }
}
</style>
