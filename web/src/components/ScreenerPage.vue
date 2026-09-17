<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import ScoreBadge from './ScoreBadge.vue';
import SicPicker from './SicPicker.vue';
import { isWatched, toggleWatch } from '../watchlist';
import { applySource, basketOf, createBasket, setSource } from '../baskets';
import { bigMoney, dateLocale, isZh, pick, t, tr } from '../i18n';
import { sicInfo } from '../../../server/lib/sic.js';
import { isNarrow, isPhone } from '../viewport';
import Note from './Note.vue';
import Loading from './Loading.vue';

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
  else if (division.value) parts.push(pick(meta.value?.divisions?.find((d) => d.id === division.value), 'zh', 'en') || division.value);
  const cond = conditions.value.filter((c) => c.key && (c.min !== '' || c.max !== '')).map((c) => `${shortName(fieldOf(c.key)?.name || c.key)}${c.mode === 'chg' ? t('sr.chgShort') : c.mode === 'yoy' ? t('sr.yoyShort') : ''}${c.min !== '' ? `≥${c.min}` : ''}${c.max !== '' ? `≤${c.max}` : ''}`);
  return [...parts, ...cond].join(' ') || t('nav.screen');
}
function basketSource(n) {
  const { basket, ...url } = toUrlParams(); // the filters as the URL carries them: what "edit" reopens
  return { type: 'screen', params: { ...params.value }, url, n: n < basketable.value.length ? n : null, label: basketLabel() };
}
const now = () => ({ at: new Date().toISOString(), asOf: new Date().toISOString().slice(0, 10), sourceName: '尋找股票（最新財報指標）' }); // tr() words it
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
const unitLabel = (f) => (f.unit ? ` (${tr(f.unit)})` : '');

// amounts are entered in millions; percentages / ratios as shown; changes in % or points
const scale = (c) => (c.mode !== 'now' ? 1 : fieldOf(c.key)?.unit === '百萬' || fieldOf(c.key)?.unit === '百萬股' ? 1e6 : 1);
const params = computed(() => {
  const p = { sort: sortKey.value, dir: sortDir.value, limit: 500, listed: listedOnly.value ? '1' : '0' };
  if (sortMode.value !== 'now') p.sortmode = sortMode.value;
  // a change column is shown (a condition in chg / yoy mode, even before it has a number): the rows need prev / yoy
  if (conditions.value.some((c) => c.key && c.mode !== 'now')) p.history = '1';
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
const STAPLES_PHONE = ['price', 'marketCap', 'pe'];
// small screens: the filter panel is a drawer above the results
const filtersOpen = ref(false);
const activeConditions = computed(() => conditions.value.filter((c) => c.key && (c.min !== '' || c.max !== '')).length + (division.value ? 1 : 0) + (sicCode.value ? 1 : 0) + (afs.value ? 1 : 0) + exDivisions.value.length + exSics.value.filter(Boolean).length + (text.value.trim() ? 1 : 0));
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
  for (const k of isPhone.value ? STAPLES_PHONE : STAPLES) push(k, 'now');
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
  if (cur == null || b == null) return { text: '—', neg: false, title: base ? '' : mode === 'chg' ? t('sr.noPrev') : t('sr.noYoy') };
  const d = isPct(f.key) ? (b === 0 ? null : ((cur - b) / Math.abs(b)) * 100) : cur - b;
  if (d == null) return { text: '—', neg: false };
  const title = `${base.fiscalYear} ${base.fiscalPeriod}: ${fmt(f, b)} → ${fmt(f, cur)}`;
  return { text: `${d > 0 ? '+' : ''}${f1.format(d)}${isPct(f.key) ? '%' : ' pt'}`, neg: d < 0, pos: d > 0, title };
}
// a field name without its parenthetical / circled-number qualifiers, for column heads and basket names
const shortName = (name) =>
  tr(name)
    .replace(/（.*?）|\s*\(.*?\)/g, '')
    .replace(/ [①②]|\s*[①②]\/[①②]|\s*[①②]−[①②]/g, '');
const colTitle = (col) => `${shortName(col.field.name)}${col.mode === 'chg' ? ` ${t('sr.chgShort')}` : col.mode === 'yoy' ? ` ${t('sr.yoyLong')}` : ''}`;
const sicName = (r) => (isZh.value ? r.sicZh || '' : sicInfo(r.sic)?.title || r.sicZh || '');
const afsShort = (k) => (['LAF', 'ACC', 'NON'].includes(k) ? t(`afs.${k}`) : '');

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
    <button v-if="isNarrow" class="pickbar" :class="{ open: filtersOpen }" @click="filtersOpen = !filtersOpen"><span>{{ filtersOpen ? '▾' : '▸' }}</span> {{ t('sr.filters') }}<span v-if="activeConditions" class="count">{{ activeConditions }}</span></button>
    <div class="layout">
      <aside v-show="!isNarrow || filtersOpen" class="panel side">
        <div class="side-head">{{ t('sr.filters') }}</div>
        <label class="frow">
          <span>{{ t('sr.tickerName') }}</span>
          <input v-model="text" type="text" :placeholder="t('sr.tickerPlaceholder')" />
        </label>
        <label class="frow">
          <span>{{ t('sr.division') }}</span>
          <select v-model="division" @change="sicCode = ''">
            <option value="">{{ t('wl.all') }}</option>
            <option v-for="d in meta?.divisions || []" :key="d.id" :value="d.id">{{ d.id }} · {{ pick(d, 'zh', 'en') }}</option>
          </select>
        </label>
        <label class="frow">
          <span>{{ t('col.sic') }}</span>
          <SicPicker v-model="sicCode" :codes="sicOptions" :divisions="meta?.divisions || []" :count-key="listedOnly ? 'listed' : 'total'" :placeholder="t('sr.sicPlaceholder')" />
        </label>
        <label class="frow">
          <span>{{ t('col.afs') }}</span>
          <select v-model="afs">
            <option value="">{{ t('wl.all') }}</option>
            <option v-for="(v, k) in meta?.filer || {}" :key="k" :value="k">{{ pick(v, 'zh', 'label') }}</option>
          </select>
        </label>
        <label class="frow check"><input v-model="listedOnly" type="checkbox" /> {{ t('listedOnly') }}</label>

        <div class="side-head">{{ t('sr.exclude') }}</div>
        <div class="chips">
          <button v-for="d in meta?.divisions || []" :key="d.id" class="chip" :class="{ on: exDivisions.includes(d.id) }" :title="t('sr.excludeTitle', { d: `${d.id} ${pick(d, 'zh', 'en')}` })" @click="toggleExDivision(d.id)">{{ pick(d, 'zh', 'en') }}</button>
        </div>
        <div v-for="(code, i) in exSics" :key="i" class="exrow">
          <SicPicker v-model="exSics[i]" :codes="allSicOptions" :divisions="meta?.divisions || []" :count-key="listedOnly ? 'listed' : 'total'" :placeholder="t('sr.exSicPlaceholder')" />
          <button class="mini" :title="t('remove')" @click="removeExSic(i)">✕</button>
        </div>
        <div class="actions">
          <button class="mini" @click="addExSic">{{ t('sr.addExSic') }}</button>
        </div>

        <div class="side-head">{{ t('sr.conditions') }}</div>
        <div v-for="(c, i) in conditions" :key="i" class="cond">
          <div class="cond-head">
            <select v-model="c.key" @change="modesFor(c.key).includes(c.mode) || (c.mode = 'now')">
              <optgroup v-for="g in fieldGroups" :key="g.name" :label="tr(g.name)">
                <option v-for="f in g.fields" :key="f.key" :value="f.key">{{ tr(f.name) }}{{ unitLabel(f) }}</option>
              </optgroup>
            </select>
            <select v-model="c.mode" class="mode" :disabled="modesFor(c.key).length === 1" :title="c.mode === 'now' ? t('sr.modeNowTitle') : c.mode === 'chg' ? t('sr.modeChgTitle') : t('sr.modeYoyTitle')">
              <option value="now">{{ t('sr.modeNow') }}</option>
              <option value="chg" :disabled="!modesFor(c.key).includes('chg')">{{ t('sr.chgShort') }}</option>
              <option value="yoy" :disabled="!modesFor(c.key).includes('yoy')">{{ t('sr.yoyLong') }}</option>
            </select>
          </div>
          <div class="range">
            <input v-model="c.min" type="text" inputmode="decimal" :placeholder="c.mode === 'now' ? '≥' : isPct(c.key) ? '≥ %' : '≥ pt'" />
            <span class="muted">～</span>
            <input v-model="c.max" type="text" inputmode="decimal" :placeholder="c.mode === 'now' ? '≤' : isPct(c.key) ? '≤ %' : '≤ pt'" />
            <button class="mini" :title="t('sr.removeCondition')" @click="removeCondition(i)">✕</button>
          </div>
        </div>
        <div class="actions">
          <button class="mini" @click="addCondition">{{ t('sr.addCondition') }}</button>
          <button class="mini" @click="reset">{{ t('reset') }}</button>
        </div>
        <Note>{{ t('sr.note') }} {{ t(api.isStatic ? 'sr.noteMarketStatic' : 'sr.noteMarket', { snapshot: meta?.market?.updatedAt ? ` (${new Date(meta.market.updatedAt).toLocaleString(dateLocale)})` : '' }) }}</Note>
      </aside>

      <main>
        <div class="panel meta">
          <div>
            <strong>{{ t('nav.screen') }}</strong>
            <span v-if="result" class="muted small">{{ t('sr.matches', { total: result.total.toLocaleString(), scored: result.scored.toLocaleString(), count: result.count }) }}</span>
          </div>
          <div class="options">
            <Loading v-if="loading" inline small :text="t('sr.searching')" />
            <span class="copy" :title="editing ? t('sr.updateTitle', { name: editing.name }) : t('sr.makeBasketTitle')">
              <span v-if="editing" class="editing">{{ t('sr.editing', { name: editing.name }) }} <button class="mini ghost" :title="t('sr.stopEditing')" @click="stopEditing">✕</button></span>
              {{ t('top') }} <input v-model="basketN" type="number" min="1" class="n" :placeholder="String(basketable.length)" /> {{ t('sr.companiesUnit') }}
              <button v-if="editing" class="small primary" :disabled="!basketable.length" @click="updateBasket">{{ t('sr.updateBasket') }}</button>
              <button class="small" :disabled="!basketable.length" @click="makeBasket">{{ t(editing ? 'sr.newBasket' : 'sr.makeBasket', { which: Number(basketN) > 0 ? t('sr.topN', { n: Math.min(Number(basketN), basketable.length) }) : t('sr.allN', { n: basketable.length }) }) }}</button>
            </span>
            <a v-if="!api.isStatic" :href="api.screenUrl(params)" target="_blank" rel="noopener" class="small">JSON</a>
          </div>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
        <Loading v-if="!result && !error" :text="t('sr.searching')" />
        <div v-if="result" class="wrap">
          <table>
            <thead>
              <tr>
                <th class="star"></th>
                <th class="sortable" @click="sortBy('ticker')">{{ t('col.ticker') }}{{ arrow('ticker') }}</th>
                <th class="sortable" @click="sortBy('name')">{{ t('col.company') }}{{ arrow('name') }}</th>
                <th class="hide-p">{{ t('sr.industry') }}</th>
                <th class="sortable" @click="sortBy('score')">{{ t('col.score') }}{{ arrow('score') }}</th>
                <th v-for="col in columns" :key="col.id" class="num sortable" :class="{ chg: col.mode !== 'now' }" :title="tr(col.field.name) + (col.mode === 'chg' ? t('sr.chgParen') : col.mode === 'yoy' ? t('sr.yoyParen') : '')" @click="sortBy(col.field.key, col.mode)">
                  {{ colTitle(col) }}<span v-if="col.mode === 'now' && (col.field.unit === '百萬' || col.field.unit === '百萬股')" class="muted"> {{ tr('百萬') }}</span>{{ arrow(col.field.key, col.mode) }}
                </th>
                <th class="sortable num hide-p" @click="sortBy('float')">{{ t('col.float') }}{{ arrow('float') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in result.rows" :key="r.cik" class="row" @click="emit('open', r)">
                <td class="star" @click.stop="toggleWatch(r)"><span :class="{ on: isWatched(r.cik) }">{{ isWatched(r.cik) ? '★' : '☆' }}</span></td>
                <td class="mono"><a :href="`?company=${r.ticker || r.cik}`" @click.prevent>{{ r.ticker || `CIK ${r.cik}` }}</a></td>
                <td class="name">{{ r.name }}<span class="muted small afs hide-p"> {{ afsShort(r.afs) }}</span></td>
                <td class="small hide-p">{{ r.sic }} {{ sicName(r) }}</td>
                <td><ScoreBadge :score="r.score" /></td>
                <td v-for="col in columns" :key="col.id" class="num" :class="{ neg: cell(r, col).neg, pos: cell(r, col).pos, chg: col.mode !== 'now' }" :title="cell(r, col).title || ''">{{ cell(r, col).text }}</td>
                <td class="num small hide-p">{{ bigMoney(r.float) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!result.rows.length" class="empty muted">{{ t('sr.noMatch') }}</p>
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
  background: var(--neg-soft);
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
  color: var(--star);
}
.empty {
  text-align: center;
  padding: 40px;
}
.pickbar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  margin-bottom: 10px;
  font-weight: 600;
}
.pickbar.open {
  border-color: var(--accent);
}
.pickbar .count {
  font-size: 11px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 8px;
  padding: 0 6px;
}
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
    max-height: none;
  }
}
@media (max-width: 760px) {
  .wrap {
    max-height: none;
  }
  .meta .options {
    flex-wrap: wrap;
  }
  .name {
    min-width: 120px;
    font-size: 12px;
  }
  th,
  td {
    padding: 5px 6px;
  }
}
.copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.copy .editing {
  color: var(--accent-strong);
  font-weight: 600;
}
.copy button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
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
  background: var(--neg-soft);
  border-color: var(--neg-border);
  color: var(--bad);
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
  color: var(--pos);
}
th.chg,
td.chg {
  background: var(--hover);
}
</style>
