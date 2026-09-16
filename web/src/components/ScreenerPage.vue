<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import ScoreBadge from './ScoreBadge.vue';
import SicPicker from './SicPicker.vue';
import { isWatched, toggleWatch } from '../watchlist';
import { applySource, basketOf, createBasket, setSource } from '../baskets';

// params: the screen as it appears in the URL (see App.vue); `navigate`
// reports every change so the URL and the browser history follow along
const props = defineProps({ params: { type: Object, default: () => ({}) } });
const emit = defineEmits(['open', 'basket', 'navigate']);

const meta = ref(null); // { fields, divisions, filer, market }
const sic = ref(null); // /api/browse/sic
const text = ref('');
const division = ref('');
const sicCode = ref('');
const afs = ref('');
const listedOnly = ref(true);
const exDivisions = ref([]); // division ids to leave out
const exSics = ref([]); // SIC codes to leave out, one dropdown row each
// condition rows: { key, mode: 'now' | 'chg' | 'yoy', min, max }
//   now = the latest filing's figure; chg = change since the previous filing;
//   yoy = change since the same period a year earlier
const DEFAULT_CONDITIONS = [
  { key: 'score', mode: 'now', min: 60, max: '' },
  { key: 'grossMargin', mode: 'now', min: '', max: '' },
  { key: 'roe', mode: 'now', min: '', max: '' },
  { key: 'debtRatio', mode: 'now', min: '', max: '' },
];
const conditions = ref(DEFAULT_CONDITIONS.map((c) => ({ ...c })));
const sortKey = ref('score');
const sortDir = ref('desc');
const sortMode = ref('now');
const result = ref(null);
const loading = ref(false);
const error = ref(null);

// ---- URL <-> state ----
const MODES = { now: '', chg: 'chg', yoy: 'yoy' };
function toUrlParams() {
  const p = {};
  if (editing.value) p.basket = editing.value.id;
  if (text.value.trim()) p.q = text.value.trim();
  if (division.value) p.division = division.value;
  if (sicCode.value) p.sic = sicCode.value;
  if (afs.value) p.afs = afs.value;
  if (!listedOnly.value) p.listed = '0';
  if (exDivisions.value.length) p.exdiv = exDivisions.value.join(',');
  if (exSics.value.filter(Boolean).length) p.exsic = exSics.value.filter(Boolean).join(',');
  const cond = conditions.value.filter((c) => c.key).map((c) => [c.key, MODES[c.mode] || '', c.min ?? '', c.max ?? ''].join(':'));
  if (cond.length) p.cond = cond.join(';');
  if (sortKey.value !== 'score' || sortDir.value !== 'desc' || sortMode.value !== 'now') {
    p.sort = sortKey.value;
    p.dir = sortDir.value;
    if (sortMode.value !== 'now') p.sortmode = sortMode.value;
  }
  return p;
}
let applying = false;
function applyUrlParams(p) {
  applying = true;
  text.value = p.q || '';
  division.value = p.division || '';
  sicCode.value = p.sic || '';
  afs.value = p.afs || '';
  listedOnly.value = p.listed !== '0';
  exDivisions.value = p.exdiv ? String(p.exdiv).split(',').filter(Boolean) : [];
  exSics.value = p.exsic ? String(p.exsic).split(',').filter(Boolean) : [];
  if (p.cond != null) {
    conditions.value = String(p.cond)
      .split(';')
      .filter(Boolean)
      .map((s) => {
        const [key, mode, min, max] = s.split(':');
        return { key, mode: mode === 'chg' || mode === 'yoy' ? mode : 'now', min: min ?? '', max: max ?? '' };
      });
  } else if (Object.keys(p).length === 0) conditions.value = DEFAULT_CONDITIONS.map((c) => ({ ...c }));
  else conditions.value = [];
  sortKey.value = p.sort || 'score';
  sortDir.value = p.dir === 'asc' ? 'asc' : 'desc';
  sortMode.value = p.sortmode === 'chg' || p.sortmode === 'yoy' ? p.sortmode : 'now';
  applying = false;
}
watch(
  () => props.params,
  (p) => {
    if (JSON.stringify(p || {}) !== JSON.stringify(toUrlParams())) applyUrlParams(p || {});
  },
  { deep: true },
);

// the results (as sorted; all of them, or the first N) as a new custom ETF -
// or, when the page was opened from a basket's "edit filters" link
// (?basket=<id>), as that basket's new source
const basketN = ref('');
const basketable = computed(() => (result.value?.rows || []).filter((r) => r.ticker));
const editing = computed(() => (props.params?.basket ? basketOf(props.params.basket) : null) || null);
watch(
  editing,
  (b) => {
    if (b?.source?.n) basketN.value = String(b.source.n);
    if (b && !b.source?.url && meta.value) applyUrlParams({ ...legacyParams(b.source?.params || {}), basket: b.id });
  },
  { immediate: true },
);
// baskets saved before the URL form was kept only have the API params
// (amounts already scaled to dollars): turn them back into filters
function legacyParams(p) {
  const out = {};
  for (const k of ['q', 'division', 'sic', 'afs', 'exdiv', 'exsic']) if (p[k]) out[k] = p[k];
  if (p.listed === '0') out.listed = '0';
  const cond = {};
  for (const [k, v] of Object.entries(p)) {
    const m = /^(.+?)(?:_(chg|yoy))?_(min|max)$/.exec(k);
    if (!m) continue;
    const c = (cond[`${m[1]}:${m[2] || ''}`] ??= { key: m[1], mode: m[2] || 'now', min: '', max: '' });
    c[m[3]] = String(Number(v) / scale(c));
  }
  if (Object.keys(cond).length) out.cond = Object.values(cond).map((c) => [c.key, MODES[c.mode] || '', c.min, c.max].join(':')).join(';');
  if (p.sort && (p.sort !== 'score' || p.dir !== 'desc' || p.sortmode)) {
    out.sort = p.sort;
    out.dir = p.dir || 'desc';
    if (p.sortmode) out.sortmode = p.sortmode;
  }
  return out;
}
function stopEditing() {
  const { basket, ...rest } = toUrlParams();
  emit('navigate', rest);
}
function basketLabel() {
  const parts = [];
  if (sicCode.value) parts.push(sicCode.value);
  else if (division.value) parts.push(meta.value?.divisions?.find((d) => d.id === division.value)?.zh || division.value);
  const cond = conditions.value.filter((c) => c.key && (c.min !== '' || c.max !== '')).map((c) => `${(fieldOf(c.key)?.name || c.key).replace(/（.*?）/g, '')}${c.mode === 'chg' ? '較上期' : c.mode === 'yoy' ? '較去年' : ''}${c.min !== '' ? `≥${c.min}` : ''}${c.max !== '' ? `≤${c.max}` : ''}`);
  return [...parts, ...cond].join(' ') || '尋找股票';
}
function basketSource(n) {
  const { basket, ...url } = toUrlParams(); // the filters as the URL carries them: what "edit" reopens
  return { type: 'screen', params: { ...params.value }, url, n: n < basketable.value.length ? n : null, label: basketLabel() };
}
const now = () => ({ at: new Date().toISOString(), asOf: new Date().toISOString().slice(0, 10), sourceName: '尋找股票（最新財報指標）' });
function makeBasket() {
  const n = Number(basketN.value) > 0 ? Math.floor(Number(basketN.value)) : basketable.value.length;
  const rows = basketable.value.slice(0, n);
  if (!rows.length) return;
  const src = basketSource(n);
  createBasket(src.label, rows, { prune: true, source: src, sync: { ...now(), added: [], removed: [], changed: 0 } });
  emit('basket');
}
// the edited filters become the basket's source; the list is resynced the
// usual way (manual rows and typed weights survive, excluded names stay out)
function updateBasket() {
  const b = editing.value;
  if (!b) return;
  const n = Number(basketN.value) > 0 ? Math.floor(Number(basketN.value)) : basketable.value.length;
  const rows = basketable.value.slice(0, n);
  if (!rows.length) return;
  const src = basketSource(n);
  const renamed = b.name === b.source?.label; // a name the user never changed follows the filters
  setSource(b.id, src, renamed ? src.label : null);
  applySource(b, rows.map((x) => ({ ticker: x.ticker, cik: x.cik, name: x.name, weight: 1 })), now());
  b.prune = true;
  emit('basket');
}
const fieldOf = (key) => meta.value?.fields.find((f) => f.key === key) || null;
const fieldGroups = computed(() => {
  const out = [];
  for (const f of meta.value?.fields || []) {
    const g = out.find((x) => x.name === f.group);
    if (g) g.fields.push(f);
    else out.push({ name: f.group, fields: [f] });
  }
  return out;
});
const sicOptions = computed(() => {
  if (!sic.value) return [];
  const d = division.value ? sic.value.divisions.find((x) => x.id === division.value) : null;
  return sic.value.codes.filter((c) => (listedOnly.value ? c.listed : c.total) && (!d || c.division === d.id)).sort((a, b) => a.code.localeCompare(b.code));
});
// change filters compare with earlier filings: market figures have none
const modesFor = (key) => (fieldOf(key)?.market ? ['now'] : ['now', 'chg', 'yoy']);
const isPct = (key) => fieldOf(key)?.unit === '百萬' || fieldOf(key)?.unit === '百萬股' || key === 'score'; // changes shown as % growth
const unitLabel = (f) => (f.unit === '百萬' ? '（百萬）' : f.unit === '%' ? '（%）' : f.unit ? `（${f.unit}）` : '');

// amounts are entered in millions; percentages / ratios as shown; changes in % or points
const scale = (c) => (c.mode !== 'now' ? 1 : fieldOf(c.key)?.unit === '百萬' || fieldOf(c.key)?.unit === '百萬股' ? 1e6 : 1);
const params = computed(() => {
  const p = { sort: sortKey.value, dir: sortDir.value, limit: 500, listed: listedOnly.value ? '1' : '0' };
  if (sortMode.value !== 'now') p.sortmode = sortMode.value;
  if (text.value.trim()) p.q = text.value.trim();
  if (division.value) p.division = division.value;
  if (sicCode.value) p.sic = sicCode.value;
  if (afs.value) p.afs = afs.value;
  if (exDivisions.value.length) p.exdiv = exDivisions.value.join(',');
  if (exSics.value.filter(Boolean).length) p.exsic = exSics.value.filter(Boolean).join(',');
  for (const c of conditions.value) {
    if (!c.key) continue;
    const suffix = c.mode === 'now' ? '' : `_${c.mode}`;
    if (c.min !== '' && c.min != null && Number.isFinite(Number(c.min))) p[`${c.key}${suffix}_min`] = Number(c.min) * scale(c);
    if (c.max !== '' && c.max != null && Number.isFinite(Number(c.max))) p[`${c.key}${suffix}_max`] = Number(c.max) * scale(c);
  }
  return p;
});

let timer = null;
async function run() {
  loading.value = true;
  error.value = null;
  try {
    result.value = await api.screen(params.value);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
watch(params, () => {
  clearTimeout(timer);
  timer = setTimeout(run, 350);
  if (!applying) emit('navigate', toUrlParams());
});

function addCondition() {
  conditions.value.push({ key: 'netMargin', mode: 'now', min: '', max: '' });
}
function removeCondition(i) {
  conditions.value.splice(i, 1);
}
function reset() {
  applyUrlParams({});
}
// every SIC with a company, for the exclusion pickers
const allSicOptions = computed(() => (sic.value ? sic.value.codes.filter((c) => (listedOnly.value ? c.listed : c.total)).sort((a, b) => a.code.localeCompare(b.code)) : []));
function addExSic() {
  exSics.value.push('');
}
function removeExSic(i) {
  exSics.value.splice(i, 1);
}
function toggleExDivision(id) {
  const i = exDivisions.value.indexOf(id);
  if (i >= 0) exDivisions.value.splice(i, 1);
  else exDivisions.value.push(id);
}
function sortBy(k, mode = 'now') {
  if (sortKey.value === k && sortMode.value === mode) sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc';
  else {
    sortKey.value = k;
    sortMode.value = mode;
    sortDir.value = k === 'name' || k === 'ticker' ? 'asc' : 'desc';
  }
}
const arrow = (k, mode = 'now') => (sortKey.value === k && sortMode.value === mode ? (sortDir.value === 'asc' ? ' ▲' : ' ▼') : '');

// result columns: the fields used in conditions (with their change columns) plus a few staples
const STAPLES = ['price', 'marketCap', 'pe', 'grossMargin', 'opMargin', 'netMargin', 'roe', 'debtRatio', 'currentRatio', 'revenueAnn'];
const columns = computed(() => {
  const out = [];
  const seen = new Set();
  const push = (key, mode) => {
    const id = `${key}:${mode}`;
    const f = fieldOf(key);
    if (!f || seen.has(id)) return;
    seen.add(id);
    out.push({ field: f, mode, id });
  };
  for (const c of conditions.value) {
    if (!c.key || c.key === 'score') continue;
    push(c.key, 'now');
    if (c.mode !== 'now') push(c.key, c.mode);
  }
  if (sortMode.value !== 'now') push(sortKey.value, sortMode.value);
  for (const k of STAPLES) push(k, 'now');
  return out;
});
const f1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const f2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const f0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
function fmt(field, v) {
  if (v == null) return '—';
  switch (field.unit) {
    case '%':
      return `${f1.format(v)}%`;
    case '次':
    case '倍':
      return `${f2.format(v)}`;
    case '天':
    case '股':
      return f0.format(v);
    case '元':
    case '美元':
      return f2.format(v);
    case '百萬':
    case '百萬股':
      return f0.format(v / 1e6);
    default:
      return f1.format(v);
  }
}
// a cell: the value, or the change vs the previous / year-earlier filing
function cell(r, col) {
  const { field: f, mode } = col;
  if (f.market) return { text: fmt(f, r.market?.[f.key]), neg: (r.market?.[f.key] ?? 0) < 0 };
  const cur = f.key === 'score' ? r.score.score : r.values?.[f.key];
  if (mode === 'now') return { text: fmt(f, cur), neg: (cur ?? 0) < 0 };
  const base = mode === 'chg' ? r.prev : r.yoy;
  const b = !base ? null : f.key === 'score' ? base.score : base.values?.[f.key];
  if (cur == null || b == null) return { text: '—', neg: false, title: base ? '' : mode === 'chg' ? '沒有上一期財報' : '沒有去年同期財報' };
  const d = isPct(f.key) ? (b === 0 ? null : ((cur - b) / Math.abs(b)) * 100) : cur - b;
  if (d == null) return { text: '—', neg: false };
  const title = `${base.fiscalYear} ${base.fiscalPeriod}：${fmt(f, b)} → ${fmt(f, cur)}`;
  return { text: `${d > 0 ? '+' : ''}${f1.format(d)}${isPct(f.key) ? '%' : ' pt'}`, neg: d < 0, pos: d > 0, title };
}
const colTitle = (col) => `${col.field.name.replace(/（.*?）/g, '').replace(/ [①②]|\s*[①②]\/[①②]|\s*[①②]−[①②]/g, '')}${col.mode === 'chg' ? ' 較上期' : col.mode === 'yoy' ? ' 較去年同期' : ''}`;
const AFS_ZH = { LAF: '大型加速', ACC: '加速', NON: '非加速' };
const cap = (v) => (v == null ? '—' : v >= 1e12 ? `${f2.format(v / 1e12)} 兆` : v >= 1e9 ? `${f1.format(v / 1e9)} 十億` : `${f0.format(v / 1e6)} 百萬`);

onMounted(async () => {
  applyUrlParams(props.params || {});
  try {
    [meta.value, sic.value] = await Promise.all([api.screenFields(), api.browseSic()]);
  } catch (e) {
    error.value = e.message;
  }
  const b = editing.value;
  if (b && !b.source?.url) applyUrlParams({ ...legacyParams(b.source?.params || {}), basket: b.id });
  run();
});
</script>

<template>
  <div class="screen">
    <div class="layout">
      <aside class="panel side">
        <div class="side-head">篩選條件</div>
        <label class="frow">
          <span>代號 / 名稱</span>
          <input v-model="text" type="text" placeholder="例如 NVDA" />
        </label>
        <label class="frow">
          <span>產業大類</span>
          <select v-model="division" @change="sicCode = ''">
            <option value="">全部</option>
            <option v-for="d in meta?.divisions || []" :key="d.id" :value="d.id">{{ d.id }} · {{ d.zh }}</option>
          </select>
        </label>
        <label class="frow">
          <span>產業 (SIC)</span>
          <SicPicker v-model="sicCode" :codes="sicOptions" :divisions="meta?.divisions || []" :count-key="listedOnly ? 'listed' : 'total'" placeholder="全部；輸入代碼或名稱搜尋…" />
        </label>
        <label class="frow">
          <span>申報身分</span>
          <select v-model="afs">
            <option value="">全部</option>
            <option v-for="(v, k) in meta?.filer || {}" :key="k" :value="k">{{ v.zh }}</option>
          </select>
        </label>
        <label class="frow check"><input v-model="listedOnly" type="checkbox" /> 只列有股票代號的公司</label>

        <div class="side-head">排除產業</div>
        <div class="chips">
          <button v-for="d in meta?.divisions || []" :key="d.id" class="chip" :class="{ on: exDivisions.includes(d.id) }" :title="`排除 ${d.id} ${d.zh}`" @click="toggleExDivision(d.id)">{{ d.zh }}</button>
        </div>
        <div v-for="(code, i) in exSics" :key="i" class="exrow">
          <SicPicker v-model="exSics[i]" :codes="allSicOptions" :divisions="meta?.divisions || []" :count-key="listedOnly ? 'listed' : 'total'" placeholder="要排除的產業：輸入代碼或名稱搜尋…" />
          <button class="mini" title="移除" @click="removeExSic(i)">✕</button>
        </div>
        <div class="actions">
          <button class="mini" @click="addExSic">＋ 排除產業 (SIC)</button>
        </div>

        <div class="side-head">條件（最新財報 / 現在市場）</div>
        <div v-for="(c, i) in conditions" :key="i" class="cond">
          <div class="cond-head">
            <select v-model="c.key" @change="modesFor(c.key).includes(c.mode) || (c.mode = 'now')">
              <optgroup v-for="g in fieldGroups" :key="g.name" :label="g.name">
                <option v-for="f in g.fields" :key="f.key" :value="f.key">{{ f.name }}{{ unitLabel(f) }}</option>
              </optgroup>
            </select>
            <select v-model="c.mode" class="mode" :disabled="modesFor(c.key).length === 1" :title="c.mode === 'now' ? '最新一份財報的數值' : c.mode === 'chg' ? '與上一份財報相比的變化（比率：百分點；金額、評分：成長 %）' : '與去年同期財報相比的變化（比率：百分點；金額、評分：成長 %）'">
              <option value="now">目前</option>
              <option value="chg" :disabled="!modesFor(c.key).includes('chg')">較上期</option>
              <option value="yoy" :disabled="!modesFor(c.key).includes('yoy')">較去年同期</option>
            </select>
          </div>
          <div class="range">
            <input v-model="c.min" type="text" inputmode="decimal" :placeholder="c.mode === 'now' ? '≥' : isPct(c.key) ? '≥ %' : '≥ pt'" />
            <span class="muted">～</span>
            <input v-model="c.max" type="text" inputmode="decimal" :placeholder="c.mode === 'now' ? '≤' : isPct(c.key) ? '≤ %' : '≤ pt'" />
            <button class="mini" title="移除條件" @click="removeCondition(i)">✕</button>
          </div>
        </div>
        <div class="actions">
          <button class="mini" @click="addCondition">＋ 加條件</button>
          <button class="mini" @click="reset">重設</button>
        </div>
        <p class="muted small">
          財報數字取自每家公司最新一份已下載的 10-K / 10-Q（年初至今、年化，與評分相同），金額以百萬為單位、幣別為財報幣別；「較上期」「較去年同期」用背景抓下來的前幾期財報比較。
          股價、市值、估值倍數來自 TradingView 的市場快照{{ meta?.market?.updatedAt ? `（${new Date(meta.market.updatedAt).toLocaleString()}）` : '' }}，每半小時更新；市值以百萬美元輸入。
        </p>
      </aside>

      <main>
        <div class="panel meta">
          <div>
            <strong>尋找股票</strong>
            <span v-if="result" class="muted small">符合 {{ result.total.toLocaleString() }} 家（已有財報 {{ result.scored.toLocaleString() }} 家），顯示前 {{ result.count }}</span>
          </div>
          <div class="options">
            <span v-if="loading" class="muted small">搜尋中…</span>
            <span class="copy" :title="editing ? `這裡改完條件後：更新「${editing.name}」的來源並重新同步（手動加的、手動改權重的、已排除的都保留），或另外建一個新的` : '把目前排序的結果組成自製 ETF（等權重），畫成 K 線；留空 = 全部'">
              <span v-if="editing" class="editing">編輯「{{ editing.name }}」的條件 <button class="mini ghost" title="不更新，回到一般搜尋" @click="stopEditing">✕</button></span>
              前 <input v-model="basketN" type="number" min="1" class="n" :placeholder="String(basketable.length)" /> 家
              <button v-if="editing" class="small primary" :disabled="!basketable.length" @click="updateBasket">更新這個 ETF</button>
              <button class="small" :disabled="!basketable.length" @click="makeBasket">{{ Number(basketN) > 0 ? `前 ${Math.min(Number(basketN), basketable.length)} 家` : `全部 ${basketable.length} 家` }}{{ editing ? '建立新 ETF' : '組成自製 ETF' }}</button>
            </span>
            <a :href="api.screenUrl(params)" target="_blank" rel="noopener" class="small">JSON</a>
          </div>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
        <div v-if="result" class="wrap">
          <table>
            <thead>
              <tr>
                <th class="star"></th>
                <th class="sortable" @click="sortBy('ticker')">代號{{ arrow('ticker') }}</th>
                <th class="sortable" @click="sortBy('name')">公司{{ arrow('name') }}</th>
                <th>產業</th>
                <th class="sortable" @click="sortBy('score')">評分{{ arrow('score') }}</th>
                <th v-for="col in columns" :key="col.id" class="num sortable" :class="{ chg: col.mode !== 'now' }" :title="col.field.name + (col.mode === 'chg' ? '（較上一期財報）' : col.mode === 'yoy' ? '（較去年同期財報）' : '')" @click="sortBy(col.field.key, col.mode)">
                  {{ colTitle(col) }}<span v-if="col.mode === 'now' && (col.field.unit === '百萬' || col.field.unit === '百萬股')" class="muted"> 百萬</span>{{ arrow(col.field.key, col.mode) }}
                </th>
                <th class="sortable num" @click="sortBy('float')">公眾流通市值{{ arrow('float') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in result.rows" :key="r.cik" class="row" @click="emit('open', r)">
                <td class="star" @click.stop="toggleWatch(r)"><span :class="{ on: isWatched(r.cik) }">{{ isWatched(r.cik) ? '★' : '☆' }}</span></td>
                <td class="mono"><a :href="`?company=${r.ticker || r.cik}`" @click.prevent>{{ r.ticker || `CIK ${r.cik}` }}</a></td>
                <td class="name">{{ r.name }}<span class="muted small afs"> {{ AFS_ZH[r.afs] || '' }}</span></td>
                <td class="small">{{ r.sic }} {{ r.sicZh || '' }}</td>
                <td><ScoreBadge :score="r.score" /></td>
                <td v-for="col in columns" :key="col.id" class="num" :class="{ neg: cell(r, col).neg, pos: cell(r, col).pos, chg: col.mode !== 'now' }" :title="cell(r, col).title || ''">{{ cell(r, col).text }}</td>
                <td class="num small">{{ r.float == null ? '—' : r.float >= 1e12 ? `${f2.format(r.float / 1e12)} 兆` : `${f0.format(r.float / 1e8)} 億` }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!result.rows.length" class="empty muted">沒有符合條件的公司，放寬一點試試。</p>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 16px;
  align-items: start;
}
main {
  min-width: 0;
}
.side {
  padding: 12px;
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  overflow: auto;
}
.side-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin: 8px 0 6px;
}
.frow {
  display: grid;
  grid-template-columns: 84px 1fr;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
  font-size: 13px;
}
.frow.check {
  display: flex;
  gap: 6px;
}
.frow input[type='text'],
.frow select,
.cond select,
.range input {
  font: inherit;
  font-size: 13px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  min-width: 0;
  width: 100%;
}
.cond {
  display: grid;
  grid-template-columns: 1fr;
  gap: 4px;
  margin: 6px 0 10px;
}
.range {
  display: grid;
  grid-template-columns: 1fr auto 1fr auto;
  gap: 6px;
  align-items: center;
}
.actions {
  display: flex;
  gap: 6px;
  margin: 4px 0 10px;
}
.mini {
  font-size: 11px;
  padding: 3px 8px;
}
.meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 16px;
  margin-bottom: 12px;
}
.meta .small {
  margin-left: 8px;
}
.options {
  display: flex;
  gap: 12px;
  align-items: center;
}
.small {
  font-size: 12px;
}
.error {
  color: var(--neg);
  background: #fee2e2;
  padding: 8px 12px;
  border-radius: 6px;
}
.wrap {
  overflow: auto;
  max-height: calc(100vh - 160px);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
table {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
}
th,
td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  text-align: left;
}
thead th {
  position: sticky;
  top: 0;
  background: var(--panel);
  z-index: 1;
  font-weight: 600;
  border-bottom: 2px solid var(--border);
  font-size: 12px;
}
.sortable {
  cursor: pointer;
  user-select: none;
}
.sortable:hover {
  color: var(--accent);
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
td.neg {
  color: var(--neg);
}
.name {
  white-space: normal;
  min-width: 180px;
}
.afs {
  margin-left: 4px;
}
tr.row {
  cursor: pointer;
}
tr.row:hover td {
  background: var(--accent-soft);
}
tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
td.star,
th.star {
  width: 28px;
  text-align: center;
  cursor: pointer;
  color: var(--muted);
  font-size: 15px;
}
td.star .on {
  color: #f59e0b;
}
.empty {
  text-align: center;
  padding: 40px;
}
@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
    max-height: none;
  }
}
.copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.copy .editing {
  color: #1d4ed8;
  font-weight: 600;
}
.copy button.primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}
.copy input.n {
  width: 56px;
  font: inherit;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  text-align: right;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.chip {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel);
  cursor: pointer;
}
.chip.on {
  background: #fee2e2;
  border-color: #fca5a5;
  color: #991b1b;
  text-decoration: line-through;
}
.cond-head {
  display: flex;
  gap: 4px;
}
.exrow {
  display: flex;
  gap: 4px;
  margin: 4px 0;
}

.cond-head select:first-child {
  flex: 1;
  min-width: 0;
}
.cond-head select.mode {
  width: 92px;
  flex: none;
}
td.pos {
  color: #15803d;
}
th.chg,
td.chg {
  background: #f8fafc;
}
</style>
