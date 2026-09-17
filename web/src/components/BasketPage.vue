<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { url } from '../base';
import CompanySearch from './CompanySearch.vue';
import KlineChart from './KlineChart.vue';
import TvEmbedChart from './TvEmbedChart.vue';
import Icon from './Icon.vue';
import { addConstituent, applySource, basketOf, baskets, createBasket, equalWeights, normalizeWeights, removeBasket, removeConstituent, removeConstituents, renameConstituent, restoreExcluded, revertWeight, setManualWeight } from '../baskets';
import { watchlist } from '../watchlist';
import { dateLocale, t, tr } from '../i18n';
import Note from './Note.vue';
import Loading from './Loading.vue';

const emit = defineEmits(['open', 'screen']);

const RANGES = [
  ['1y', 1],
  ['3y', 3],
  ['5y', 5],
  ['10y', 10],
];
const BENCHMARKS = [
  ['SPY', () => 'S&P 500 (SPY)'],
  ['QQQ', () => 'Nasdaq 100 (QQQ)'],
  ['DIA', () => t('bk.dow')],
  ['IWM', () => 'Russell 2000 (IWM)'],
  ['', () => t('bk.noBenchmark')],
];

const range = ref(localStorage.getItem('stockscan.basket.range') || '3y');
const benchmark = ref(localStorage.getItem('stockscan.basket.bench') ?? 'SPY');
const colors = ref(localStorage.getItem('stockscan.kcolors') || 'tw');
// chart: 'own'    = Advanced Charts / Lightweight Charts on the bars the server fetched
//                   (TradingView websocket, else TWS, else Yahoo) - any number of stocks
//        'widget' = TradingView's embeddable widget on a spread symbol (its own data, at most 10 stocks)
// the pure-frontend build computes the index from the bars the build shipped
// (data/bars, TradingView's to the build's day); a build without them has
// TradingView's widget only
const isStatic = api.isStatic;
const noBars = ref(isStatic); // settled by quotesStatus()
const chartSource = ref(isStatic || localStorage.getItem('stockscan.basket.chart') === 'widget' ? 'widget' : 'own');
watch(chartSource, (v) => localStorage.setItem('stockscan.basket.chart', v));
watch(range, (v) => localStorage.setItem('stockscan.basket.range', v));
watch(benchmark, (v) => localStorage.setItem('stockscan.basket.bench', v));
watch(colors, (v) => localStorage.setItem('stockscan.kcolors', v));

const quotes = ref(null); // /api/quotes/status
const advanced = ref(false); // TradingView Advanced Charts loaded
const result = ref(null);
const loading = ref(false);
const progress = ref(null); // { done, total, current, members[] } while the bars stream in
let aborter = null;
const error = ref(null);
const newName = ref('');
const addMsg = ref('');
const renaming = ref(false); // title inline rename
const pruned = ref(''); // "removed X, Y" message after an automatic prune
const sideRename = ref(null); // { id, to } rename in the sidebar list

// temporarily hidden constituents (eye toggle): left out of the index, weights
// untouched, so their effect on the chart can be checked; not saved
const hidden = ref({}); // basket id -> Set of tickers
const hiddenOf = (id) => hidden.value[id] || new Set();
const isHidden = (c) => current.value && hiddenOf(current.value.id).has(c.ticker);
function toggleHidden(c) {
  if (!current.value) return;
  const set = new Set(hiddenOf(current.value.id));
  if (set.has(c.ticker)) set.delete(c.ticker);
  else set.add(c.ticker);
  hidden.value = { ...hidden.value, [current.value.id]: set };
}
function showAll() {
  if (current.value) hidden.value = { ...hidden.value, [current.value.id]: new Set() };
}
const hiddenCount = computed(() => (current.value ? current.value.constituents.filter((c) => isHidden(c)).length : 0));
// names whose price data stopped (delisted, taken private), that EDGAR's
// ticker table no longer lists, or that no source knows. A basket copied from
// a list is pruned of these when it is created, so whatever is here went
// after that - it gets its own table so the user sees it.
const delisted = computed(() => {
  if (!result.value || !current.value) return [];
  const gone = new Set([...result.value.constituents.filter((c) => c.delisted).map((c) => c.symbol), ...(result.value.failed || []).map((f) => f.ticker)]);
  return current.value.constituents.filter((c) => gone.has(c.ticker)).map((c) => c.ticker);
});
const delistedSet = computed(() => new Set(delisted.value));
// why a name counts as delisted: what the server saw for it
function delistedWhy(c) {
  const p = perf.value[c.ticker];
  const f = result.value?.failed?.find((x) => x.ticker === c.ticker);
  const l = p || f;
  if (l?.renamed) return { text: t('bk.whyRenamed', { to: l.renamed }), renamed: l.renamed };
  if (l && l.listed === false) return { text: p?.last ? t('bk.whyUnlistedSince', { last: p.last }) : t('bk.whyUnlisted'), renamed: null };
  if (p?.delisted) return { text: t('bk.whyNoQuotes', { last: p.last }), renamed: null };
  return { text: t('bk.whyNoData', { err: f?.error ? ` (${f.error})` : '' }), renamed: null };
}
function removeDelisted() {
  if (!current.value || !delisted.value.length) return;
  const n = removeConstituents(current.value.id, delisted.value);
  pruned.value = t('bk.removedN', { n });
}
function followRename(c, to) {
  if (renameConstituent(current.value.id, c.ticker, to)) run(true);
}

// ---- source resync ----
const syncing = ref(false);
const syncMsg = ref('');
const syncFailed = ref(false);
const sourceLabel = (src) =>
  !src ? '' : src.type === 'etf' ? t('bk.srcEtf', { ticker: src.ticker, top: src.n ? t('bk.topParen', { n: src.n }) : '' }) : src.type === 'screen' ? t('bk.srcScreen', { label: src.label || '', top: src.n ? t('bk.topParen', { n: src.n }) : '' }) : src.type === 'watch' ? t('bk.srcWatch', { group: src.group === 'all' ? t('wl.all') : src.group }) : '';
async function fetchSource(src) {
  if (src.type === 'etf') {
    const r = await api.etfLive(src.ticker);
    const rows = r.holdings.filter((h) => h.symbol && h.weight > 0).sort((a, b) => b.weight - a.weight);
    return { holdings: (src.n ? rows.slice(0, src.n) : rows).map((h) => ({ ticker: h.symbol, cik: h.cik, name: h.name, weight: h.weight })), sourceName: r.source, asOf: r.asOf, note: r.note, approximate: r.approximate };
  }
  if (src.type === 'screen') {
    const r = await api.screen({ ...src.params, limit: src.n || 2000 });
    const rows = r.rows.filter((x) => x.ticker);
    return { holdings: (src.n ? rows.slice(0, src.n) : rows).map((x) => ({ ticker: x.ticker, cik: x.cik, name: x.name, weight: 1 })), sourceName: '尋找股票（最新財報指標）', asOf: new Date().toISOString().slice(0, 10) }; // tr() words it
  }
  if (src.type === 'watch') {
    const items = (src.group === 'all' ? watchlist.items : watchlist.items.filter((x) => x.groups.includes(src.group))).filter((x) => x.ticker);
    return { holdings: items.map((x) => ({ ticker: x.ticker, cik: x.cik, name: x.name, weight: 1 })), sourceName: '觀察名單', asOf: new Date().toISOString().slice(0, 10) };
  }
  throw new Error('unknown source');
}
async function resync() {
  const b = current.value;
  if (!b?.source || syncing.value) return;
  syncing.value = true;
  syncMsg.value = '';
  try {
    const r = await fetchSource(b.source);
    const d = applySource(b, r.holdings, { sourceName: r.sourceName, asOf: r.asOf });
    b.prune = true; // newly added names may already be delisted
    const parts = [];
    if (d.added.length) parts.push(t('bk.syncAdded', { n: d.added.length, list: d.added.slice(0, 12).join(t('sep')) + (d.added.length > 12 ? '…' : '') }));
    if (d.removed.length) parts.push(t('bk.syncRemoved', { n: d.removed.length, list: d.removed.slice(0, 12).join(t('sep')) + (d.removed.length > 12 ? '…' : '') }));
    if (d.changed) parts.push(t('bk.syncChanged', { n: d.changed }));
    syncMsg.value = t('bk.synced', { source: tr(r.sourceName), asOf: r.asOf || '—', changes: parts.length ? parts.join(t('bk.semicolon')) : t('bk.noChange') });
    syncFailed.value = false;
  } catch (e) {
    syncMsg.value = t('bk.syncFailed', { msg: e.message });
    syncFailed.value = true;
  } finally {
    syncing.value = false;
  }
}
const manualCount = computed(() => (current.value ? current.value.constituents.filter((c) => c.origin === 'manual' || c.manualWeight).length : 0));
// the constituent tables: one, or split by where each row comes from when the basket has a source
const groups = computed(() => {
  if (!current.value) return [];
  const live = rows.value.filter((c) => !delistedSet.value.has(c.ticker));
  const rowsOf = (pred) => live.filter(pred);
  if (!current.value.source) return [{ key: 'all', title: '', rows: live }];
  return [
    { key: 'source', title: t('bk.groupSource', { src: sourceLabel(current.value.source) }), rows: rowsOf((c) => c.origin === 'source' && !c.gone), hint: t('bk.groupSourceHint') },
    { key: 'manual', title: t('bk.groupManual'), rows: rowsOf((c) => c.origin === 'manual'), hint: t('bk.groupManualHint') },
    { key: 'gone', title: t('bk.groupGone'), rows: rowsOf((c) => c.origin === 'source' && c.gone), hint: t('bk.groupGoneHint') },
  ].filter((g) => g.rows.length);
});
// put an excluded name back: off the list, then a resync brings it in with the source's weight
async function restore(ticker = null) {
  if (!current.value) return;
  restoreExcluded(current.value.id, ticker);
  await resync();
}
function onWeightInput(c, ev) {
  const v = ev.target.value;
  if (v === '' || v == null) return;
  setManualWeight(current.value.id, c.ticker, Number(v));
}
const inIndex = (c) => Number(c.weight) > 0 && !isHidden(c);

const current = computed(() => basketOf(baskets.current) || baskets.items[0] || null);
watch(
  () => baskets.items.length,
  () => {
    if (!basketOf(baskets.current)) baskets.current = baskets.items[0]?.id ?? null;
  },
);

async function loadQuotes() {
  try {
    quotes.value = await api.quotesStatus();
    if (isStatic) {
      noBars.value = !quotes.value.bars;
      if (!noBars.value && localStorage.getItem('stockscan.basket.chart') !== 'widget') chartSource.value = 'own';
    }
    if (quotes.value.tvLibrary && !window.TradingView?.widget) await loadTvLibrary();
    advanced.value = !!window.TradingView?.widget;
  } catch {
    quotes.value = null;
  }
}
// the licensed library, served by the backend from web/assets/tradingview/
function loadTvLibrary() {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = url('/tradingview/charting_library/charting_library.standalone.js');
    s.onload = resolve;
    s.onerror = resolve;
    document.head.appendChild(s);
  });
}
async function reconnect() {
  try {
    const r = await api.ibConnect();
    quotes.value = { ...(quotes.value || {}), ib: r.ib };
    if (r.ib.connected) run();
  } catch {
    /* status poll will tell */
  }
}

// the request that produced the current chart (so edits only refetch when they change it)
let lastKey = '';
let seq = 0;
async function run(force = false) {
  const b = current.value;
  if (!b || !b.constituents.length) {
    result.value = null;
    lastKey = '';
    return;
  }
  const included = b.constituents.filter(inIndex);
  if (!included.length) {
    result.value = null;
    lastKey = '';
    return;
  }
  const body = { constituents: included.map((c) => ({ ticker: c.ticker, cik: c.cik, weight: Number(c.weight) })), range: range.value, rebalance: b.rebalance, benchmark: benchmark.value || null };
  const key = JSON.stringify(body);
  if (!force && key === lastKey) return;
  lastKey = key;
  if (noBars.value) {
    result.value = null;
    error.value = null;
    return;
  }
  const id = ++seq;
  loading.value = true;
  error.value = null;
  progress.value = null;
  aborter?.abort(); // a superseded request stops the server's work too
  aborter = new AbortController();
  try {
    let r = null;
    // bars stream in one constituent at a time: progress shows as they land, the
    // chart (the previous one stays up meanwhile) is replaced once by the final index
    await api.basketStream(
      body,
      (ev) => {
        if (id !== seq) return;
        if (ev.type === 'start') progress.value = { done: 0, total: ev.total, current: null, members: [] };
        else if (ev.type === 'member') {
          const p = progress.value || { done: 0, total: ev.total, current: null, members: [] };
          p.done = ev.done;
          p.total = ev.total;
          p.current = ev.symbol;
          p.members.unshift(ev);
          p.members.length = Math.min(p.members.length, 6);
          progress.value = { ...p };
        } else if (ev.type === 'series') {
          if (!ev.partial) r = ev;
        } else if (ev.type === 'error') throw new Error(ev.error);
      },
      aborter.signal,
    );
    if (id !== seq) return;
    if (!r) throw new Error(t('bk.disconnected'));
    result.value = r;
    // a basket copied from an ETF / list: names that no longer trade go now that the prices show which they are
    if (b.prune) {
      b.prune = false;
      const gone = r.constituents.filter((c) => c.delisted).map((c) => c.symbol);
      for (const f of r.failed || []) gone.push(f.ticker); // no price data anywhere: not tradeable either
      if (gone.length) {
        removeConstituents(b.id, gone);
        pruned.value = t('bk.pruned', { n: gone.length, list: gone.join(t('sep')) });
      }
    }
    // TWS may have come up (or gone) since the page loaded
    if (quotes.value && (r.ib !== quotes.value.ib?.connected || r.tv !== quotes.value.tv?.connected)) api.quotesStatus().then((q) => (quotes.value = q)).catch(() => {});
  } catch (e) {
    if (id !== seq || e.name === 'AbortError') return;
    error.value = e.message;
    result.value = null;
  } finally {
    if (id === seq) {
      loading.value = false;
      progress.value = null;
    }
  }
}
onBeforeUnmount(() => aborter?.abort());
onMounted(async () => {
  await loadQuotes();
  run();
});
watch([current, range, benchmark, hidden], () => run());
watch(current, () => {
  pruned.value = '';
  syncMsg.value = '';
});
// weights are typed in: wait for the typing to stop before refetching
let editTimer = null;
watch(
  () => current.value && [current.value.rebalance, current.value.constituents.map((c) => `${c.ticker}:${c.weight}`).join(',')],
  () => {
    clearTimeout(editTimer);
    editTimer = setTimeout(run, 500);
  },
);

// ---- baskets ----
function create() {
  const name = newName.value.trim() || `${t('nav.basket')} ${baskets.items.length + 1}`;
  createBasket(name, []);
  newName.value = '';
}
function remove(b) {
  if (!confirm(t('bk.confirmDelete', { name: b.name }))) return;
  removeBasket(b.id);
}
function startSideRename(b) {
  sideRename.value = { id: b.id, to: b.name };
}
function finishSideRename() {
  const r = sideRename.value;
  if (r) {
    const b = basketOf(r.id);
    const name = r.to.trim();
    if (b && name) b.name = name;
  }
  sideRename.value = null;
}
function duplicate(b) {
  createBasket(t('bk.copyOf', { name: b.name }), b.constituents.map((c) => ({ ...c })), { rebalance: b.rebalance });
}
// every stock of a watchlist group (or the whole list) into a new basket
const groupOptions = computed(() => [['all', `${t('bk.wholeWatchlist')} (${watchlist.items.length})`], ...watchlist.groups.map((g) => [g, `${g} (${watchlist.items.filter((x) => x.groups.includes(g)).length})`])]);
const fromGroup = ref('');
function createFromGroup() {
  const g = fromGroup.value;
  if (!g) return;
  const items = (g === 'all' ? watchlist.items : watchlist.items.filter((x) => x.groups.includes(g))).filter((x) => x.ticker);
  if (!items.length) return;
  createBasket(g === 'all' ? t('nav.watch') : g, items);
  fromGroup.value = '';
}
async function addFromSearch(ticker) {
  addMsg.value = '';
  if (!current.value) return;
  try {
    const c = await api.company(ticker);
    const tk = c.tickers?.[0];
    if (!tk) throw new Error(t('bk.noTicker'));
    addMsg.value = addConstituent(current.value.id, { ticker: tk, cik: c.cik, name: c.name }) ? t('bk.addedTicker', { t: tk }) : t('bk.alreadyIn', { t: tk });
  } catch (e) {
    addMsg.value = t('notFound', { msg: e.message });
  }
}

// ---- display ----
const f2 = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const pct = (v, sign = true) => (v == null || !Number.isFinite(v) ? '—' : `${sign && v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
const cls = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
// weights are percentages; when they do not add up to 100 the index uses them
// proportionally, and the footer offers to rescale
const totalWeight = computed(() => (current.value ? current.value.constituents.reduce((s, c) => s + (Number(c.weight) > 0 ? Number(c.weight) : 0), 0) : 0));
// what the index actually uses: hidden rows drop out and the rest share their weight
const activeWeight = computed(() => (current.value ? current.value.constituents.reduce((s, c) => s + (inIndex(c) ? Number(c.weight) : 0), 0) : 0));
const weightPct = (c) => (activeWeight.value && inIndex(c) ? Number(c.weight) / activeWeight.value : 0);
const totalOff = computed(() => Math.abs(totalWeight.value - 100) > 0.5); // 30 × 3.33 is 100 enough
const scaled = computed(() => totalOff.value || hiddenCount.value > 0);
const f1 = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
const perf = computed(() => Object.fromEntries((result.value?.constituents || []).map((c) => [c.symbol, c])));
const benchStats = computed(() => {
  const p = result.value?.benchmark?.points;
  if (!p?.length) return null;
  return { total: p.at(-1).value / p[0].value - 1 };
});
const sortKey = ref('weight');
const sortDir = ref(-1);
function sortBy(k) {
  if (sortKey.value === k) sortDir.value = -sortDir.value;
  else {
    sortKey.value = k;
    sortDir.value = k === 'ticker' || k === 'name' ? 1 : -1;
  }
}
const arrow = (k) => (sortKey.value === k ? (sortDir.value > 0 ? ' ▲' : ' ▼') : '');
const rows = computed(() => {
  if (!current.value) return [];
  const k = sortKey.value;
  const val = (c) => (k === 'weight' ? weightPct(c) : k === 'return' ? (perf.value[c.ticker]?.return ?? null) : k === 'contribution' ? (perf.value[c.ticker]?.contribution ?? null) : c[k] ?? '');
  return [...current.value.constituents].sort((a, b) => {
    const x = val(a) ?? -Infinity;
    const y = val(b) ?? -Infinity;
    if (x === y) return 0;
    return (x < y ? -1 : 1) * sortDir.value;
  });
});
// ---- TradingView spread symbol for the basket ----
const TV_SPREAD_MAX = 10; // TradingView's limit on tickers in one spread
// 60M is a TradingView preset that switches to weekly bars; 61M keeps daily
const TV_RANGE = { '1y': '12M', '3y': '36M', '5y': '61M', '10y': '120M' };
const tvSymbol = (t) => String(t).toUpperCase().replace(/-/g, '.'); // BRK-B -> BRK.B
const sig = (v) => Number(v.toPrecision(6));
const tvIncluded = computed(() => (current.value ? current.value.constituents.filter(inIndex) : []));
const tvTooMany = computed(() => tvIncluded.value.length > TV_SPREAD_MAX);
// coefficient = holding units at the basket's start (base 100), so the level
// matches the stats; without own bars (TWS and Yahoo both down) plain weights
const tvExpression = computed(() =>
  tvIncluded.value
    .map((c) => {
      const p = perf.value[c.ticker]?.startClose;
      const k = p ? (weightPct(c) * 100) / p : weightPct(c) * 100;
      return `${sig(k)}*${tvSymbol(c.ticker)}`;
    })
    .join('+'),
);
const tvCompare = computed(() => {
  if (!benchmark.value) return '';
  const p = result.value?.benchmark?.startClose;
  return p ? `${sig(100 / p)}*${tvSymbol(benchmark.value)}` : tvSymbol(benchmark.value);
});
// wait for the first stats result so the coefficients are right from the start (or for its failure: then plain weights)
const useTv = computed(() => chartSource.value === 'widget' && tvIncluded.value.length > 0 && !tvTooMany.value && (result.value || error.value || noBars.value));

const upColor = computed(() => (colors.value === 'us' ? '#16a34a' : '#dc2626'));
const downColor = computed(() => (colors.value === 'us' ? '#dc2626' : '#16a34a'));
// the data chain: TradingView websocket, then TWS, then Yahoo
const sourceText = computed(() => {
  const q = quotes.value;
  if (!q) return '';
  if (q.static) return q.bars ? t('bk.staticBars', { date: q.builtAt ? new Date(q.builtAt).toLocaleDateString(dateLocale.value) : '—' }) : t('bk.staticWidget');
  const parts = [];
  parts.push(!q.tv?.enabled ? t('bk.tvDisabled') : q.tv.connected ? 'TradingView ✓' : `TradingView (${q.tv.lastError || t('bk.notConnected')})`);
  parts.push(!q.ib?.enabled ? t('bk.ibDisabled') : q.ib.connected ? `IBKR ✓ (${q.ib.host}:${q.ib.port})` : t('bk.ibNotConnected', { host: q.ib.host, port: q.ib.port }));
  parts.push('Yahoo');
  return t('bk.sources', { list: parts.join(' → ') });
});
</script>

<template>
  <div class="basket">
    <div class="layout">
      <aside class="panel side">
        <div class="side-head">{{ t('nav.basket') }}</div>
        <div class="items">
        <div v-for="b in baskets.items" :key="b.id" class="item" :class="{ active: current?.id === b.id }" @click="baskets.current = b.id">
          <template v-if="sideRename?.id === b.id">
            <input v-model="sideRename.to" type="text" class="rename" @keyup.enter="finishSideRename" @keyup.esc="sideRename = null" @blur="finishSideRename" @click.stop />
          </template>
          <template v-else>
            <span class="bname">{{ b.name }}</span> <span class="muted">{{ b.constituents.length }}</span>
            <span class="tools">
              <button class="mini icon" :title="t('rename')" @click.stop="startSideRename(b)"><Icon name="pencil" :size="13" /></button>
              <button class="mini icon" :title="t('delete')" @click.stop="remove(b)"><Icon name="x" :size="13" /></button>
            </span>
          </template>
        </div>
        </div>
        <p v-if="!baskets.items.length" class="muted small">{{ t('bk.none') }}</p>
        <div class="newgroup">
          <input v-model="newName" type="text" :placeholder="t('bk.newPlaceholder')" @keyup.enter="create" />
          <button class="mini" @click="create">{{ t('add') }}</button>
        </div>
        <div v-if="watchlist.items.length" class="fromgroup">
          <select v-model="fromGroup" @change="createFromGroup">
            <option value="">{{ t('bk.fromWatchlist') }}</option>
            <option v-for="[k, label] in groupOptions" :key="k" :value="k">{{ label }}</option>
          </select>
        </div>
        <p class="muted small hide-p">{{ t('bk.storage') }}</p>
        <p v-if="sourceText" class="muted small src hide-p">
          {{ sourceText }}
          <button v-if="quotes?.ib?.enabled && !quotes.ib.connected" class="mini" @click="reconnect">{{ t('bk.reconnect') }}</button>
        </p>
      </aside>

      <main v-if="current">
        <div class="panel meta">
          <div class="title">
            <template v-if="renaming">
              <input v-model="current.name" type="text" class="rename" @keyup.enter="renaming = false" @blur="renaming = false" />
            </template>
            <template v-else>
              <strong @dblclick="renaming = true">{{ current.name }}</strong>
              <button class="mini ghost icon" :title="t('rename')" @click="renaming = true"><Icon name="pencil" :size="14" /></button>
            </template>
            <span class="muted small">{{ t('bk.names', { n: current.constituents.length }) }}</span>
            <span v-if="result?.start" class="muted small">{{ result.start }} ～ {{ result.end }}{{ t('bk.startIs100') }}</span>
            <Loading v-if="loading" inline small :text="progress ? t('bk.fetching', { done: progress.done, total: progress.total }) : t('bk.computing')" />
          </div>
          <div class="options">
            <span class="seg">
              <button v-for="[k, n] in RANGES" :key="k" class="small" :class="{ active: range === k }" @click="range = k">{{ t('chart.years', { n }) }}</button>
            </span>
            <select v-model="current.rebalance" class="small" :title="t('bk.rebalanceTitle')">
              <option value="none">{{ t('bk.buyHold') }}</option>
              <option value="daily">{{ t('bk.dailyRebalance') }}</option>
            </select>
            <select v-model="benchmark" class="small" :title="t('bk.benchmarkTitle')">
              <option v-for="[k, label] in BENCHMARKS" :key="k" :value="k">{{ label() }}</option>
            </select>
            <select v-if="!noBars" v-model="chartSource" class="small" :title="t(isStatic ? 'bk.chartSourceTitleStatic' : 'bk.chartSourceTitle')">
              <option value="own">{{ t('bk.chartOwn') }}</option>
              <option value="widget">{{ t('bk.chartWidget') }}</option>
            </select>
            <select v-model="colors" class="small hide-p" :title="t('bk.candleColors')">
              <option value="tw">{{ t('chart.tw') }}</option>
              <option value="us">{{ t('chart.us') }}</option>
            </select>
            <button class="small hide-p" :title="t('bk.duplicateTitle')" @click="duplicate(current)">{{ t('bk.duplicate') }}</button>
            <button class="small danger" @click="remove(current)">{{ t('delete') }}</button>
          </div>
        </div>

        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="pruned" class="muted small note infobox">{{ pruned }} <button class="mini ghost" @click="pruned = ''">✕</button></p>
        <div v-if="current.source" class="panel srcbar">
          <div class="small">
            <b>{{ t('bk.source') }}</b> {{ sourceLabel(current.source) }}
            <span v-if="current.sync" class="muted">· {{ tr(current.sync.sourceName) }}<template v-if="current.sync.asOf">{{ t('bk.asOf', { date: current.sync.asOf }) }}</template> · {{ t('bk.lastSync', { time: new Date(current.sync.at).toLocaleString(dateLocale.value) }) }}</span>
            <span v-if="manualCount" class="muted">· {{ t('bk.manualCount', { n: manualCount }) }}</span>
            <span v-if="current.excluded?.length" class="muted">· {{ t('bk.excludedCount', { n: current.excluded.length }) }}</span>
          </div>
          <div class="options">
            <span v-if="syncMsg" class="small" :class="{ warn: syncFailed }">{{ syncMsg }}</span>
            <button v-if="current.source.type === 'screen'" class="small" :title="t('bk.editFiltersTitle')" @click="emit('screen', current)">{{ t('bk.editFilters') }}</button>
            <button class="small" :disabled="syncing" :title="t('bk.resyncTitle')" @click="resync"><Loading v-if="syncing" inline small :text="t('bk.syncing')" /><template v-else>{{ t('bk.resync') }}</template></button>
          </div>
        </div>
        <p v-if="!current.constituents.length" class="empty muted">{{ t('bk.empty') }}</p>

        <div v-if="loading && !useTv" class="panel progressbox" :class="{ overlay: result?.bars?.length }">
          <div class="pbar" :class="{ indeterminate: !progress }">
            <div class="fill" :style="{ width: progress ? `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` : '30%' }"></div>
          </div>
          <div class="ptext small">
            <template v-if="progress">
              <b>{{ progress.done }} / {{ progress.total }}</b> {{ t('bk.barsArrived') }}<template v-if="progress.done < progress.total">{{ t(isStatic ? 'bk.barsFetchingStatic' : 'bk.barsFetching') }}</template><template v-else>{{ t('bk.barsComputing') }}</template>…
              <span class="chips">
                <span v-for="m in progress.members" :key="m.symbol" class="chip mono" :class="{ bad: m.error, bench: m.bench }" :title="m.error ? m.error : `${m.source} · ${m.first} ～ ${m.last} (${t('bk.days', { n: m.days })})`">{{ m.symbol }}</span>
              </span>
            </template>
            <Loading v-else inline small :text="t('bk.connecting')" />
          </div>
        </div>
        <div v-if="useTv || result?.bars?.length" class="panel chart">
          <TvEmbedChart v-if="useTv" :expression="tvExpression" :compare="tvCompare" :range="TV_RANGE[range] || 'ALL'" :colors="colors" />
          <KlineChart v-else :bars="result.bars" :overlay="result.benchmark?.points || []" :overlay-label="result.benchmark?.symbol || ''" :label="current.name" :colors="colors" :advanced="advanced" />
          <div v-if="result?.stats" class="stats">
            <div><span class="muted small">{{ t('bk.periodReturn') }}</span><b class="mono" :class="cls(result.stats.total)">{{ pct(result.stats.total) }}</b></div>
            <div v-if="benchStats"><span class="muted small">{{ t('bk.samePeriod', { symbol: result.benchmark.symbol }) }}</span><b class="mono" :class="cls(benchStats.total)">{{ pct(benchStats.total) }}</b></div>
            <div><span class="muted small">{{ t('bk.cagr') }}</span><b class="mono" :class="cls(result.stats.cagr)">{{ pct(result.stats.cagr) }}</b></div>
            <div><span class="muted small">{{ t('bk.vol') }}</span><b class="mono">{{ pct(result.stats.vol, false) }}</b></div>
            <div :title="t('bk.drawdownTitle', { from: result.stats.drawdownFrom, to: result.stats.drawdownTo })"><span class="muted small">{{ t('bk.maxDrawdown') }}</span><b class="mono down">{{ pct(result.stats.maxDrawdown) }}</b></div>
            <div :title="result.stats.best?.date"><span class="muted small">{{ t('bk.bestDay') }}</span><b class="mono up">{{ pct(result.stats.best?.r) }}</b></div>
            <div :title="result.stats.worst?.date"><span class="muted small">{{ t('bk.worstDay') }}</span><b class="mono down">{{ pct(result.stats.worst?.r) }}</b></div>
            <div><span class="muted small">{{ t('bk.tradingDays') }}</span><b class="mono">{{ result.stats.days }}</b></div>
          </div>
          <p v-if="useTv" class="muted small note">
            {{ t('bk.widgetNoteA') }} <span class="mono">{{ tvExpression }}</span>{{ tvCompare ? t('bk.widgetCompare', { c: tvCompare }) : '' }}{{ t('bk.widgetNoteB') }}
            {{ noBars ? t('bk.widgetStatic') : t('bk.widgetStats', { src: result ? `: ${result.source}` : t('bk.widgetWaiting') }) }}{{ current.rebalance === 'daily' ? t('bk.widgetRebalance') : '' }}
          </p>
          <p v-for="(n, i) in result?.notes || []" :key="i" class="muted small note">※ {{ t(`bkNote.${n.code}`, n) }}</p>
        </div>
        <p v-if="chartSource === 'widget' && tvTooMany" class="muted small note warnbox">{{ t('bk.tooMany', { n: tvIncluded.length }) }}</p>

        <div v-if="current" class="panel editor">
          <div class="add">
            <CompanySearch @select="addFromSearch" />
            <span class="muted small">{{ addMsg || t('bk.addHint') }}</span>
            <button v-if="current.constituents.length" class="mini" :title="t('bk.equalTitle')" @click="equalWeights(current.id)">{{ t('bk.equal') }}</button>
          </div>
        </div>

        <div v-for="g in groups" :key="g.key" class="panel wrap">
          <div v-if="g.title" class="ghead"><b>{{ g.title }}</b> <span class="muted small">{{ t('bk.names', { n: g.rows.length }) }} · {{ g.hint }}</span></div>
          <table>
            <thead>
              <tr>
                <th class="eye" :class="{ some: hiddenCount }" :title="hiddenCount ? t('bk.showAll') : t('bk.eyeTitle')" @click="hiddenCount && showAll()">
                  <Icon :name="hiddenCount ? 'eye-off' : 'eye'" />
                </th>
                <th class="sortable" @click="sortBy('ticker')">{{ t('col.ticker') }}{{ arrow('ticker') }}</th>
                <th class="sortable" @click="sortBy('name')">{{ t('col.company') }}{{ arrow('name') }}</th>
                <th class="num sortable" :title="t('bk.weightTitle')" @click="sortBy('weight')">{{ t('bk.weightPct') }}{{ arrow('weight') }}</th>
                <th v-if="current.source" class="num hide-p" :title="t('bk.sourceWeightTitle')">{{ t('bk.sourceWeight') }}</th>
                <th class="num hide-p">{{ t('bk.startClose') }}</th>
                <th class="num hide-p">{{ t('bk.lastClose') }}</th>
                <th class="num sortable" @click="sortBy('return')">{{ t('bk.periodReturn') }}{{ arrow('return') }}</th>
                <th class="num sortable hide-p" :title="t('bk.contributionTitle')" @click="sortBy('contribution')">{{ t('bk.contribution') }}{{ arrow('contribution') }}</th>
                <th class="hide-t">{{ t('bk.data') }}</th>
                <th class="del"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in g.rows" :key="c.ticker" class="row" :class="{ off: isHidden(c) }" @click="emit('open', c)">
                <td class="eye" :title="isHidden(c) ? t('bk.hiddenTitle') : t('bk.hideTitle')" @click.stop="toggleHidden(c)"><Icon :name="isHidden(c) ? 'eye-off' : 'eye'" /></td>
                <td class="mono"><a :href="`?company=${c.ticker}`" @click.prevent>{{ c.ticker }}</a></td>
                <td class="name">{{ c.name }}</td>
                <td class="num weight" @click.stop>
                  <input :value="c.weight" type="number" min="0" max="100" step="1" class="w" :class="{ zero: !(Number(c.weight) > 0), manual: c.manualWeight || c.origin === 'manual' }" @input="onWeightInput(c, $event)" />
                  <span class="mono small muted" :title="scaled ? t('bk.effectiveWeight') : ''">{{ isHidden(c) ? t('bk.hidden') : !(Number(c.weight) > 0) ? t('bk.notIncluded') : scaled ? `→ ${pct(weightPct(c), false)}` : '' }}</span>
                  <span v-if="c.origin === 'source' && c.manualWeight" class="tag manual" :title="t('bk.manualTitle')">{{ t('bk.manual') }}</span>
                  <button v-if="c.origin === 'source' && c.manualWeight" class="mini ghost" :title="c.gone ? t('bk.revertGone') : t('bk.revert', { w: c.sourceWeight })" @click="revertWeight(current.id, c.ticker)">↺</button>
                </td>
                <td v-if="current.source" class="num mono small muted hide-p">{{ c.origin === 'source' && c.sourceWeight != null && !c.gone ? f1.format(c.sourceWeight) + '%' : '—' }}</td>
                <td class="num mono hide-p">{{ perf[c.ticker]?.startClose != null ? f2.format(perf[c.ticker].startClose) : '—' }}</td>
                <td class="num mono hide-p">{{ perf[c.ticker]?.endClose != null ? f2.format(perf[c.ticker].endClose) : '—' }}</td>
                <td class="num mono" :class="cls(perf[c.ticker]?.return)">{{ pct(perf[c.ticker]?.return) }}</td>
                <td class="num mono hide-p" :class="cls(perf[c.ticker]?.contribution)">{{ pct(perf[c.ticker]?.contribution) }}</td>
                <td class="small muted hide-t">
                  <template v-if="perf[c.ticker]">
                    <span v-if="perf[c.ticker].illiquid" class="warn" :title="t('bk.illiquidTitle')">{{ t('bk.illiquid') }}</span>
                    {{ perf[c.ticker].source }} · {{ t('bk.from', { date: perf[c.ticker].first }) }}<span v-if="perf[c.ticker].joined && perf[c.ticker].joined !== result.start" class="warn">{{ t('bk.joinedOn', { date: perf[c.ticker].joined }) }}</span><span v-if="perf[c.ticker].delisted" class="warn" :title="t('bk.delistedTitle')">{{ t('bk.noQuotesAfter', { date: perf[c.ticker].last }) }}</span><span v-else-if="perf[c.ticker].left" class="warn">{{ t('bk.leftOn', { date: perf[c.ticker].left }) }}</span><span v-else-if="!perf[c.ticker].joined" class="warn">{{ t('bk.noDataInRange') }}</span>
                  </template>
                  <span v-else-if="result?.failed?.find((f) => f.ticker === c.ticker)" class="down">{{ t('bk.noData') }}</span>
                  <template v-else>{{ inIndex(c) && !noBars ? '…' : '—' }}</template>
                </td>
                <td class="del" :title="t('bk.removeTitle', { t: c.ticker, src: c.origin === 'source' ? t('bk.removeSourceNote') : '' })" @click.stop="removeConstituent(current.id, c.ticker)"><Icon name="trash" /></td>
              </tr>
            </tbody>
            <tfoot v-if="g.key === groups.at(-1).key">
              <tr>
                <td colspan="3" class="muted small">
                  {{ t('bk.included', { n: current.constituents.filter(inIndex).length }) }}<template v-if="hiddenCount">{{ t('bk.hiddenN', { n: hiddenCount }) }} <button class="mini ghost" @click="showAll">{{ t('bk.showAll') }}</button></template>
                  <template v-if="delisted.length"> · <span class="warn">{{ t('bk.delistedN', { n: delisted.length }) }}</span></template>
                </td>
                <td class="num weight">
                  <b class="mono" :class="{ off: totalOff }">{{ f1.format(totalWeight) }}%</b>
                  <button v-if="totalOff" class="mini" :title="t('bk.normalizeTitle')" @click="normalizeWeights(current.constituents)">{{ t('bk.normalize') }}</button>
                  <button v-else class="mini ghost" :title="t('bk.equalTitle')" @click="equalWeights(current.id)">{{ t('bk.equal') }}</button>
                </td>
                <td :colspan="current.source ? 7 : 6" class="muted small hide-p">{{ totalOff ? t('bk.totalOff') : hiddenCount ? t('bk.hiddenShare') : '' }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div v-if="delisted.length" class="panel wrap excluded delisted">
          <div class="ghead">
            <b class="warn">{{ t('bk.delistedHead') }}</b> <span class="muted small">{{ t('bk.names', { n: delisted.length }) }} · {{ t('bk.delistedHint') }}</span>
            <button class="mini" :title="t('bk.removeAllTitle')" @click="removeDelisted">{{ t('bk.removeAll') }}</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>{{ t('col.ticker') }}</th>
                <th>{{ t('col.company') }}</th>
                <th class="num">{{ t('bk.weightPct') }}</th>
                <th class="num">{{ t('bk.lastCloseCol') }}</th>
                <th>{{ t('bk.status') }}</th>
                <th class="del"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in rows.filter((x) => delistedSet.has(x.ticker))" :key="c.ticker" class="row" @click="emit('open', c)">
                <td class="mono"><a :href="`?company=${c.ticker}`" @click.prevent>{{ c.ticker }}</a></td>
                <td class="name">{{ c.name }}</td>
                <td class="num mono">{{ f1.format(c.weight) }}%</td>
                <td class="num mono">{{ perf[c.ticker]?.endClose != null ? f2.format(perf[c.ticker].endClose) : '—' }}<span v-if="perf[c.ticker]?.last" class="small muted"> ({{ perf[c.ticker].last }})</span></td>
                <td class="small warn">
                  {{ delistedWhy(c).text }}
                  <button v-if="delistedWhy(c).renamed" class="mini" @click.stop="followRename(c, delistedWhy(c).renamed)">{{ t('bk.useRenamed', { t: delistedWhy(c).renamed }) }}</button>
                </td>
                <td class="del" :title="t('bk.removeTitle', { t: c.ticker, src: '' })" @click.stop="removeConstituent(current.id, c.ticker)"><Icon name="trash" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="current.source && current.excluded?.length" class="panel wrap excluded">
          <div class="ghead">
            <b>{{ t('bk.excludedHead') }}</b> <span class="muted small">{{ t('bk.names', { n: current.excluded.length }) }} · {{ t('bk.excludedHint') }}</span>
            <button class="mini" @click="restore()">{{ t('bk.restoreAll') }}</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>{{ t('col.ticker') }}</th>
                <th>{{ t('col.company') }}</th>
                <th class="num" :title="t('bk.sourceWeightTitle')">{{ t('bk.sourceWeight') }}</th>
                <th>{{ t('bk.excludedAt') }}</th>
                <th class="del"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in current.excluded" :key="e.ticker" class="row" @click="emit('open', e)">
                <td class="mono"><a :href="`?company=${e.ticker}`" @click.prevent>{{ e.ticker }}</a></td>
                <td class="name">{{ e.name }}</td>
                <td class="num mono small muted">{{ e.sourceWeight != null ? f1.format(e.sourceWeight) + '%' : '—' }}</td>
                <td class="small muted">{{ e.at ? new Date(e.at).toLocaleString(dateLocale.value) : '—' }}</td>
                <td class="del" @click.stop><button class="mini" :disabled="syncing" :title="t('bk.restoreTitle')" @click="restore(e.ticker)">{{ t('bk.restore') }}</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <Note>{{ t('bk.indexNote', { adv: advanced ? t('bk.indexNoteAdvanced') : '' }) }}</Note>
      </main>
      <main v-else>
        <p class="empty muted">{{ t('bk.noCurrent') }}</p>
      </main>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.side {
  position: sticky;
  top: 12px;
}
.side-head {
  font-weight: 600;
  margin: 4px 0 8px;
}
.item {
  display: flex;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.item:hover {
  background: var(--row-alt);
}
.item.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.bname {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item .tools {
  display: none;
  gap: 2px;
  margin-left: 4px;
}
.item:hover .tools {
  display: inline-flex;
}
.item .tools button {
  padding: 0 5px;
  line-height: 18px;
}
.item .rename {
  flex: 1;
  width: auto;
  min-width: 0;
  font: inherit;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
td.eye,
th.eye,
td.del,
th.del {
  width: 32px;
  text-align: center;
  user-select: none;
  padding-left: 8px;
  padding-right: 4px;
  color: var(--muted);
}
td.eye,
td.del,
th.eye.some {
  cursor: pointer;
}
td.eye svg,
td.del svg,
th.eye svg {
  vertical-align: middle;
}
td.eye:hover,
th.eye.some:hover {
  color: var(--accent);
}
td.del:hover {
  color: var(--neg);
}
tr.off td.eye {
  color: var(--muted);
}
button.icon {
  display: inline-flex;
  align-items: center;
  padding: 2px 5px;
}
tr.off td {
  color: var(--muted);
}
tr.off td.name,
tr.off td.mono,
tr.off input.w {
  opacity: 0.55;
}
.newgroup {
  display: flex;
  gap: 6px;
  margin: 10px 0 6px;
}
.newgroup input {
  padding: 6px 8px;
}
.fromgroup select {
  width: 100%;
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}
.src .mini {
  margin-left: 6px;
}
.meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.title strong {
  font-size: 16px;
}
.rename {
  font-size: 16px;
  padding: 4px 8px;
  width: 240px;
}
.options {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.seg {
  display: inline-flex;
}
.seg button {
  border-radius: 0;
  margin-left: -1px;
}
.seg button:first-child {
  border-radius: 6px 0 0 6px;
  margin-left: 0;
}
.seg button:last-child {
  border-radius: 0 6px 6px 0;
}
select.small {
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}
button.small {
  font-size: 12px;
  padding: 5px 10px;
}
button.mini {
  font-size: 12px;
  padding: 2px 8px;
}
button.ghost {
  border-color: transparent;
}
button.danger:hover {
  border-color: var(--neg);
  color: var(--neg);
}
.editor {
  margin-bottom: 12px;
}
.warnbox {
  margin: 0 0 12px;
  padding: 8px 12px;
  background: #fef3c7;
  border-radius: 8px;
}
.srcbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 10px 16px;
}
.ghead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--row-alt);
}
.excluded tbody td {
  color: var(--muted);
}
.excluded tbody td.mono a {
  opacity: 0.7;
}
.tag {
  display: inline-block;
  font-size: 10px;
  border-radius: 3px;
  padding: 0 4px;
  margin-left: 4px;
  vertical-align: middle;
}
.tag.manual {
  color: #92400e;
  border: 1px solid #f59e0b;
  background: #fffbeb;
}
input.w.manual {
  border-color: #f59e0b;
  background: #fffbeb;
}
.infobox {
  margin: 0 0 12px;
  padding: 8px 12px;
  background: var(--accent-soft);
  border-radius: 8px;
}
.add {
  display: flex;
  gap: 10px;
  align-items: center;
}
.add :deep(.search) {
  width: 320px;
}
.chart {
  margin-bottom: 12px;
  padding: 12px;
}
/* progress while the constituents' daily bars stream in */
.progressbox {
  margin-bottom: 12px;
  padding: 10px 12px;
}
.progressbox.overlay {
  padding: 6px 12px;
}
.pbar {
  height: 6px;
  border-radius: 3px;
  background: #e5e7eb;
  overflow: hidden;
}
.pbar .fill {
  height: 100%;
  background: #2563eb;
  border-radius: 3px;
  transition: width 0.25s ease;
}
.pbar.indeterminate .fill {
  animation: slide 1.2s ease-in-out infinite;
}
@keyframes slide {
  0% {
    margin-left: -30%;
  }
  100% {
    margin-left: 100%;
  }
}
.ptext {
  margin-top: 6px;
  color: #4b5563;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}
.chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chip {
  padding: 0 6px;
  border-radius: 10px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 11px;
  line-height: 18px;
}
.chip.bench {
  background: #f3f4f6;
  color: #374151;
}
.chip.bad {
  background: #fef2f2;
  color: #b91c1c;
}
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.stats div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stats b {
  font-size: 15px;
}
.up {
  color: v-bind(upColor);
}
.down {
  color: v-bind(downColor);
}
.wrap {
  padding: 0;
  overflow-x: auto;
  margin-bottom: 12px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  white-space: nowrap;
}
th {
  font-weight: 600;
  background: var(--total);
  font-size: 12px;
}
th.sortable {
  cursor: pointer;
  user-select: none;
}
.num {
  text-align: right;
}
.row {
  cursor: pointer;
}
.row:hover {
  background: var(--row-alt);
}
input.w {
  width: 72px;
  font: inherit;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  text-align: right;
}
input.w:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}
input.w.zero {
  color: var(--muted);
}
td.weight {
  white-space: nowrap;
}
td.weight .small {
  display: inline-block;
  min-width: 64px;
  text-align: left;
  margin-left: 6px;
}
tfoot td {
  background: var(--total);
  border-bottom: none;
}
tfoot .off {
  color: var(--neg);
}
tfoot .mini {
  margin-left: 6px;
}
.name {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.note {
  margin: 8px 2px;
}
.warn {
  color: #b45309;
}
.empty {
  padding: 24px;
  text-align: center;
}
.small {
  font-size: 12px;
}
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
  }
  /* the baskets as a row of chips instead of a list */
  .items {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .item {
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 4px 10px;
    gap: 6px;
  }
  .item .tools {
    display: inline-flex;
  }
  .newgroup {
    display: flex;
    gap: 6px;
    margin: 8px 0;
  }
  .newgroup input {
    flex: 1;
  }
}
@media (max-width: 760px) {
  .meta {
    padding: 8px 10px;
  }
  .title {
    flex-wrap: wrap;
  }
  .rename {
    width: 100%;
  }
  .stats {
    gap: 8px 16px;
  }
  .stats b {
    font-size: 13px;
  }
  th,
  td {
    padding: 5px 6px;
  }
  .name {
    max-width: 36vw;
    font-size: 12px;
  }
  input.w {
    width: 56px;
  }
  .note {
    margin: 6px 0;
  }
}
</style>
