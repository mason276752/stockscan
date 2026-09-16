<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import CompanySearch from './CompanySearch.vue';
import KlineChart from './KlineChart.vue';
import TvEmbedChart from './TvEmbedChart.vue';
import Icon from './Icon.vue';
import { addConstituent, basketOf, baskets, createBasket, equalWeights, normalizeWeights, removeBasket, removeConstituent } from '../baskets';
import { watchlist } from '../watchlist';

const emit = defineEmits(['open']);

const RANGES = [
  ['1y', '1 年'],
  ['3y', '3 年'],
  ['5y', '5 年'],
  ['10y', '10 年'],
];
const BENCHMARKS = [
  ['SPY', 'S&P 500 (SPY)'],
  ['QQQ', 'Nasdaq 100 (QQQ)'],
  ['DIA', '道瓊 (DIA)'],
  ['IWM', 'Russell 2000 (IWM)'],
  ['', '不比較'],
];

const range = ref(localStorage.getItem('stockscan.basket.range') || '3y');
const benchmark = ref(localStorage.getItem('stockscan.basket.bench') ?? 'SPY');
const colors = ref(localStorage.getItem('stockscan.kcolors') || 'tw');
// chart: 'tv' = TradingView's official widget on TradingView data (spread symbol),
//        'own' = drawn from the TWS / Yahoo bars the stats use anyway
const chartSource = ref(localStorage.getItem('stockscan.basket.chart') || 'tv');
watch(chartSource, (v) => localStorage.setItem('stockscan.basket.chart', v));
watch(range, (v) => localStorage.setItem('stockscan.basket.range', v));
watch(benchmark, (v) => localStorage.setItem('stockscan.basket.bench', v));
watch(colors, (v) => localStorage.setItem('stockscan.kcolors', v));

const quotes = ref(null); // /api/quotes/status
const advanced = ref(false); // TradingView Advanced Charts loaded
const result = ref(null);
const loading = ref(false);
const error = ref(null);
const newName = ref('');
const addMsg = ref('');
const renaming = ref(false); // title inline rename
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
    s.src = '/tradingview/charting_library/charting_library.standalone.js';
    s.onload = resolve;
    s.onerror = resolve;
    document.head.appendChild(s);
  });
}
async function reconnect() {
  try {
    const r = await api.ibConnect();
    quotes.value = { ...(quotes.value || {}), ib: r.ib, source: r.ib.connected ? 'IBKR' : 'Yahoo Finance' };
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
  const body = { constituents: included.map((c) => ({ ticker: c.ticker, weight: Number(c.weight) })), range: range.value, rebalance: b.rebalance, benchmark: benchmark.value || null };
  const key = JSON.stringify(body);
  if (!force && key === lastKey) return;
  lastKey = key;
  const id = ++seq;
  loading.value = true;
  error.value = null;
  try {
    const r = await api.basket(body);
    if (id !== seq) return;
    result.value = r;
    // TWS may have come up (or gone) since the page loaded
    if (quotes.value && r.ib !== quotes.value.ib?.connected) api.quotesStatus().then((q) => (quotes.value = q)).catch(() => {});
  } catch (e) {
    if (id !== seq) return;
    error.value = e.message;
    result.value = null;
  } finally {
    if (id === seq) loading.value = false;
  }
}
onMounted(async () => {
  await loadQuotes();
  run();
});
watch([current, range, benchmark, hidden], () => run());
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
  const name = newName.value.trim() || `自製 ETF ${baskets.items.length + 1}`;
  createBasket(name, []);
  newName.value = '';
}
function remove(b) {
  if (!confirm(`刪除「${b.name}」？`)) return;
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
  createBasket(`${b.name} 副本`, b.constituents.map((c) => ({ ...c })), { rebalance: b.rebalance });
}
// every stock of a watchlist group (or the whole list) into a new basket
const groupOptions = computed(() => [['all', `全部觀察名單（${watchlist.items.length}）`], ...watchlist.groups.map((g) => [g, `${g}（${watchlist.items.filter((x) => x.groups.includes(g)).length}）`])]);
const fromGroup = ref('');
function createFromGroup() {
  const g = fromGroup.value;
  if (!g) return;
  const items = (g === 'all' ? watchlist.items : watchlist.items.filter((x) => x.groups.includes(g))).filter((x) => x.ticker);
  if (!items.length) return;
  createBasket(g === 'all' ? '觀察名單' : g, items);
  fromGroup.value = '';
}
async function addFromSearch(ticker) {
  addMsg.value = '';
  if (!current.value) return;
  try {
    const c = await api.company(ticker);
    const t = c.tickers?.[0];
    if (!t) throw new Error('這家公司沒有股票代號');
    addMsg.value = addConstituent(current.value.id, { ticker: t, cik: c.cik, name: c.name }) ? `已加入 ${t}` : `${t} 已在名單中`;
  } catch (e) {
    addMsg.value = `找不到：${e.message}`;
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
const totalOff = computed(() => Math.abs(totalWeight.value - 100) > 0.05);
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
const useTv = computed(() => chartSource.value === 'tv' && tvIncluded.value.length > 0 && !tvTooMany.value && (result.value || error.value));

const upColor = computed(() => (colors.value === 'us' ? '#16a34a' : '#dc2626'));
const downColor = computed(() => (colors.value === 'us' ? '#dc2626' : '#16a34a'));
const sourceText = computed(() => {
  const q = quotes.value;
  if (!q) return '';
  if (q.ib?.connected) return `報價來源：IBKR TWS（${q.ib.host}:${q.ib.port}）`;
  if (!q.ib?.enabled) return '報價來源：Yahoo Finance（IBKR 已停用）';
  return `報價來源：Yahoo Finance — TWS / IB Gateway 未連線（${q.ib.host}:${q.ib.port}${q.ib.lastError ? `，${q.ib.lastError}` : ''}）`;
});
</script>

<template>
  <div class="basket">
    <div class="layout">
      <aside class="panel side">
        <div class="side-head">自製 ETF</div>
        <div v-for="b in baskets.items" :key="b.id" class="item" :class="{ active: current?.id === b.id }" @click="baskets.current = b.id">
          <template v-if="sideRename?.id === b.id">
            <input v-model="sideRename.to" type="text" class="rename" @keyup.enter="finishSideRename" @keyup.esc="sideRename = null" @blur="finishSideRename" @click.stop />
          </template>
          <template v-else>
            <span class="bname">{{ b.name }}</span> <span class="muted">{{ b.constituents.length }}</span>
            <span class="tools">
              <button class="mini icon" title="改名" @click.stop="startSideRename(b)"><Icon name="pencil" :size="13" /></button>
              <button class="mini icon" title="刪除" @click.stop="remove(b)"><Icon name="x" :size="13" /></button>
            </span>
          </template>
        </div>
        <p v-if="!baskets.items.length" class="muted small">還沒有自製 ETF。</p>
        <div class="newgroup">
          <input v-model="newName" type="text" placeholder="新增，例如 AI 供應鏈" @keyup.enter="create" />
          <button class="mini" @click="create">新增</button>
        </div>
        <div v-if="watchlist.items.length" class="fromgroup">
          <select v-model="fromGroup" @change="createFromGroup">
            <option value="">從觀察名單建立…</option>
            <option v-for="[k, label] in groupOptions" :key="k" :value="k">{{ label }}</option>
          </select>
        </div>
        <p class="muted small">名單存在這個瀏覽器的 localStorage；在「尋找股票」的結果和觀察名單的分類也能直接組成 ETF。</p>
        <p v-if="sourceText" class="muted small src">
          {{ sourceText }}
          <button v-if="quotes?.ib?.enabled && !quotes.ib.connected" class="mini" @click="reconnect">重試連線</button>
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
              <button class="mini ghost icon" title="改名" @click="renaming = true"><Icon name="pencil" :size="14" /></button>
            </template>
            <span class="muted small">{{ current.constituents.length }} 檔</span>
            <span v-if="result?.start" class="muted small">{{ result.start }} ～ {{ result.end }}，起點 = 100</span>
            <span v-if="loading" class="muted small">計算中…</span>
          </div>
          <div class="options">
            <span class="seg">
              <button v-for="[k, label] in RANGES" :key="k" class="small" :class="{ active: range === k }" @click="range = k">{{ label }}</button>
            </span>
            <select v-model="current.rebalance" class="small" title="買進持有：權重是起點那天的配置，之後隨股價漂移；每日再平衡：每天收盤把權重調回設定值">
              <option value="none">買進持有</option>
              <option value="daily">每日再平衡</option>
            </select>
            <select v-model="benchmark" class="small" title="疊上大盤 ETF 做比較（同樣以起點 = 100）">
              <option v-for="[k, label] in BENCHMARKS" :key="k" :value="k">{{ label }}</option>
            </select>
            <select v-model="chartSource" class="small" title="TradingView 官方：用 TradingView 自己的資料把成分股組成價差商品畫 K 線（最多 10 檔）；自算：用 TWS / Yahoo 日線自己算指數">
              <option value="tv">圖：TradingView 官方</option>
              <option value="own">圖：TWS / Yahoo 自算</option>
            </select>
            <select v-model="colors" class="small" title="K 棒顏色">
              <option value="tw">紅漲綠跌</option>
              <option value="us">綠漲紅跌</option>
            </select>
            <button class="small" title="複製一份" @click="duplicate(current)">複製</button>
            <button class="small danger" @click="remove(current)">刪除</button>
          </div>
        </div>

        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="!current.constituents.length" class="empty muted">這個 ETF 還沒有成分股：在下面搜尋加入，或從尋找股票 / 觀察名單組成。</p>

        <div v-if="useTv || result?.bars?.length" class="panel chart">
          <TvEmbedChart v-if="useTv" :expression="tvExpression" :compare="tvCompare" :range="TV_RANGE[range] || 'ALL'" :colors="colors" />
          <KlineChart v-else :bars="result.bars" :overlay="result.benchmark?.points || []" :overlay-label="result.benchmark?.symbol || ''" :label="current.name" :colors="colors" :advanced="advanced" />
          <div v-if="result?.stats" class="stats">
            <div><span class="muted small">區間報酬</span><b class="mono" :class="cls(result.stats.total)">{{ pct(result.stats.total) }}</b></div>
            <div v-if="benchStats"><span class="muted small">{{ result.benchmark.symbol }} 同期</span><b class="mono" :class="cls(benchStats.total)">{{ pct(benchStats.total) }}</b></div>
            <div><span class="muted small">年化報酬</span><b class="mono" :class="cls(result.stats.cagr)">{{ pct(result.stats.cagr) }}</b></div>
            <div><span class="muted small">年化波動</span><b class="mono">{{ pct(result.stats.vol, false) }}</b></div>
            <div :title="`${result.stats.drawdownFrom} 高點 → ${result.stats.drawdownTo}`"><span class="muted small">最大回撤</span><b class="mono down">{{ pct(result.stats.maxDrawdown) }}</b></div>
            <div :title="result.stats.best?.date"><span class="muted small">最佳單日</span><b class="mono up">{{ pct(result.stats.best?.r) }}</b></div>
            <div :title="result.stats.worst?.date"><span class="muted small">最差單日</span><b class="mono down">{{ pct(result.stats.worst?.r) }}</b></div>
            <div><span class="muted small">交易日</span><b class="mono">{{ result.stats.days }}</b></div>
          </div>
          <p v-if="useTv" class="muted small note">
            圖：TradingView 官方資料，成分股組成價差商品 <span class="mono">{{ tvExpression }}</span>{{ tvCompare ? `，比較 ${tvCompare}` : '' }}（係數 = 起點時的持有單位，起點 = 100）；
            統計與下表{{ result ? `：${result.source}` : '：等 TWS / Yahoo 的日線' }}。{{ current.rebalance === 'daily' ? 'TradingView 的價差商品是買進持有，每日再平衡只反映在統計。' : '' }}
          </p>
          <p v-for="n in result?.notes || []" :key="n" class="muted small note">※ {{ n }}</p>
        </div>
        <p v-if="chartSource === 'tv' && tvTooMany" class="muted small note warnbox">
          TradingView 的價差商品最多 10 檔，這個 ETF 納入 {{ tvIncluded.length }} 檔，改用 TWS / Yahoo 自算的圖；用眼睛暫時隱藏到 10 檔以內就會切回 TradingView。
        </p>

        <div v-if="current" class="panel editor">
          <div class="add">
            <CompanySearch @select="addFromSearch" />
            <span class="muted small">{{ addMsg || '搜尋後加入成分股（新加入的分到 1/n，其餘按比例縮）' }}</span>
            <button v-if="current.constituents.length" class="mini" title="每檔相同權重" @click="equalWeights(current.id)">等權重</button>
          </div>
        </div>

        <div v-if="current.constituents.length" class="panel wrap">
          <table>
            <thead>
              <tr>
                <th class="eye" :class="{ some: hiddenCount }" :title="hiddenCount ? '全部顯示' : '暫時隱藏／顯示成分股，看對 K 線的影響（不改權重、不會儲存）'" @click="hiddenCount && showAll()">
                  <Icon :name="hiddenCount ? 'eye-off' : 'eye'" />
                </th>
                <th class="sortable" @click="sortBy('ticker')">代號{{ arrow('ticker') }}</th>
                <th class="sortable" @click="sortBy('name')">公司{{ arrow('name') }}</th>
                <th class="num sortable" title="可直接改：百分比，設 0 就不納入指數；合計不是 100 時按比例換算" @click="sortBy('weight')">權重 %{{ arrow('weight') }}</th>
                <th class="num">起點收盤</th>
                <th class="num">最新收盤</th>
                <th class="num sortable" @click="sortBy('return')">區間報酬{{ arrow('return') }}</th>
                <th class="num sortable" title="權重 × 報酬（買進持有時各檔貢獻加總 = 區間報酬）" @click="sortBy('contribution')">貢獻{{ arrow('contribution') }}</th>
                <th>資料</th>
                <th class="del"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in rows" :key="c.ticker" class="row" :class="{ off: isHidden(c) }" @click="emit('open', c)">
                <td class="eye" :title="isHidden(c) ? '暫時隱藏中，點一下放回指數' : '暫時從指數拿掉，看 K 線怎麼變'" @click.stop="toggleHidden(c)"><Icon :name="isHidden(c) ? 'eye-off' : 'eye'" /></td>
                <td class="mono"><a :href="`?company=${c.ticker}`" @click.prevent>{{ c.ticker }}</a></td>
                <td class="name">{{ c.name }}</td>
                <td class="num weight" @click.stop>
                  <input v-model.number="c.weight" type="number" min="0" max="100" step="1" class="w" :class="{ zero: !(Number(c.weight) > 0) }" />
                  <span class="mono small muted" :title="scaled ? '依納入指數的合計換算後的實際權重' : ''">{{ isHidden(c) ? '隱藏' : !(Number(c.weight) > 0) ? '未納入' : scaled ? `→ ${pct(weightPct(c), false)}` : '' }}</span>
                </td>
                <td class="num mono">{{ perf[c.ticker] ? f2.format(perf[c.ticker].startClose) : '—' }}</td>
                <td class="num mono">{{ perf[c.ticker] ? f2.format(perf[c.ticker].endClose) : '—' }}</td>
                <td class="num mono" :class="cls(perf[c.ticker]?.return)">{{ pct(perf[c.ticker]?.return) }}</td>
                <td class="num mono" :class="cls(perf[c.ticker]?.contribution)">{{ pct(perf[c.ticker]?.contribution) }}</td>
                <td class="small muted">
                  <template v-if="perf[c.ticker]"><span v-if="perf[c.ticker].illiquid" class="warn" title="成交稀少或股價低於 1 美元：單日跳動可能很大，會扭曲整個指數">⚠ 低流動性</span> {{ perf[c.ticker].source }} · {{ perf[c.ticker].first }} 起</template>
                  <span v-else-if="result?.failed?.find((f) => f.ticker === c.ticker)" class="down">無資料</span>
                  <template v-else>{{ inIndex(c) ? '…' : '—' }}</template>
                </td>
                <td class="del" :title="`從 ETF 移除 ${c.ticker}（其餘權重按比例補回 100%）`" @click.stop="removeConstituent(current.id, c.ticker)"><Icon name="trash" /></td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="3" class="muted small">{{ current.constituents.filter(inIndex).length }} 檔納入指數<template v-if="hiddenCount">，暫時隱藏 {{ hiddenCount }} 檔 <button class="mini ghost" @click="showAll">全部顯示</button></template></td>
                <td class="num weight">
                  <b class="mono" :class="{ off: totalOff }">{{ f1.format(totalWeight) }}%</b>
                  <button v-if="totalOff" class="mini" title="按比例把權重換算成合計 100%" @click="normalizeWeights(current.constituents)">湊成 100%</button>
                  <button v-else class="mini ghost" title="每檔相同權重" @click="equalWeights(current.id)">等權重</button>
                </td>
                <td colspan="6" class="muted small">{{ totalOff ? '合計不是 100%，指數依比例換算（右邊小字是實際權重）' : hiddenCount ? '隱藏的權重由其餘成分股按比例分攤（右邊小字是實際權重）' : '' }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p class="muted small note">
          指數 = 成分股以起點收盤價換算成持有單位後的加權合計（起點 = 100）；K 棒的高低點是各成分股當天高低點的加權和，會略高估真實區間。價格為除權調整後（IBKR TRADES / Yahoo），不含股利。
          圖表使用 TradingView Lightweight Charts{{ advanced ? '；已偵測到 Advanced Charts 函式庫，改用完整版' : '' }}。
        </p>
      </main>
      <main v-else>
        <p class="empty muted">先在左邊新增一個自製 ETF，或從觀察名單的分類建立。</p>
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
</style>
