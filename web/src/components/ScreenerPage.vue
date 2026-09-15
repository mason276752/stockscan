<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import ScoreBadge from './ScoreBadge.vue';
import { isWatched, toggleWatch } from '../watchlist';

const emit = defineEmits(['open']);

const meta = ref(null); // { fields, divisions, filer }
const sic = ref(null); // /api/browse/sic
const text = ref('');
const division = ref('');
const sicCode = ref('');
const afs = ref('');
const listedOnly = ref(true);
// condition rows: { key, min, max }
const DEFAULT_CONDITIONS = [
  { key: 'score', min: 60, max: '' },
  { key: 'grossMargin', min: '', max: '' },
  { key: 'roe', min: '', max: '' },
  { key: 'debtRatio', min: '', max: '' },
];
const conditions = ref(DEFAULT_CONDITIONS.map((c) => ({ ...c })));
const sortKey = ref('score');
const sortDir = ref('desc');
const result = ref(null);
const loading = ref(false);
const error = ref(null);

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

// amounts are entered in millions; percentages / ratios as shown
const scale = (key) => (fieldOf(key)?.unit === '百萬' ? 1e6 : 1);
const params = computed(() => {
  const p = { sort: sortKey.value, dir: sortDir.value, limit: 500, listed: listedOnly.value ? '1' : '0' };
  if (text.value.trim()) p.q = text.value.trim();
  if (division.value) p.division = division.value;
  if (sicCode.value) p.sic = sicCode.value;
  if (afs.value) p.afs = afs.value;
  for (const c of conditions.value) {
    if (!c.key) continue;
    if (c.min !== '' && c.min != null && Number.isFinite(Number(c.min))) p[`${c.key}_min`] = Number(c.min) * scale(c.key);
    if (c.max !== '' && c.max != null && Number.isFinite(Number(c.max))) p[`${c.key}_max`] = Number(c.max) * scale(c.key);
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
});

function addCondition() {
  conditions.value.push({ key: 'netMargin', min: '', max: '' });
}
function removeCondition(i) {
  conditions.value.splice(i, 1);
}
function reset() {
  text.value = '';
  division.value = '';
  sicCode.value = '';
  afs.value = '';
  conditions.value = DEFAULT_CONDITIONS.map((c) => ({ ...c }));
  sortKey.value = 'score';
  sortDir.value = 'desc';
}
function sortBy(k) {
  if (sortKey.value === k) sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc';
  else {
    sortKey.value = k;
    sortDir.value = k === 'name' || k === 'ticker' ? 'asc' : 'desc';
  }
}
const arrow = (k) => (sortKey.value === k ? (sortDir.value === 'asc' ? ' ▲' : ' ▼') : '');

// result columns: the fields used in conditions plus a few staples
const STAPLES = ['grossMargin', 'opMargin', 'netMargin', 'roe', 'debtRatio', 'currentRatio', 'cfRatio', 'revenue'];
const columns = computed(() => {
  const keys = [...conditions.value.map((c) => c.key).filter((k) => k && k !== 'score'), ...STAPLES];
  return [...new Set(keys)].map(fieldOf).filter(Boolean);
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
      return `${f2.format(v)}`;
    case '天':
      return f0.format(v);
    case '元':
      return f2.format(v);
    case '百萬':
      return f0.format(v / 1e6);
    default:
      return f1.format(v);
  }
}
const AFS_ZH = { LAF: '大型加速', ACC: '加速', NON: '非加速' };

onMounted(async () => {
  try {
    [meta.value, sic.value] = await Promise.all([api.screenFields(), api.browseSic()]);
  } catch (e) {
    error.value = e.message;
  }
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
          <select v-model="sicCode">
            <option value="">全部</option>
            <option v-for="c in sicOptions" :key="c.code" :value="c.code">{{ c.code }} {{ c.zh || c.title }}（{{ listedOnly ? c.listed : c.total }}）</option>
          </select>
        </label>
        <label class="frow">
          <span>申報身分</span>
          <select v-model="afs">
            <option value="">全部</option>
            <option v-for="(v, k) in meta?.filer || {}" :key="k" :value="k">{{ v.zh }}</option>
          </select>
        </label>
        <label class="frow check"><input v-model="listedOnly" type="checkbox" /> 只列有股票代號的公司</label>

        <div class="side-head">財務指標（最新財報）</div>
        <div v-for="(c, i) in conditions" :key="i" class="cond">
          <select v-model="c.key">
            <optgroup v-for="g in fieldGroups" :key="g.name" :label="g.name">
              <option v-for="f in g.fields" :key="f.key" :value="f.key">{{ f.name }}{{ f.unit === '百萬' ? '（百萬）' : f.unit === '%' ? '（%）' : f.unit ? `（${f.unit}）` : '' }}</option>
            </optgroup>
          </select>
          <div class="range">
            <input v-model="c.min" type="text" inputmode="decimal" placeholder="≥" />
            <span class="muted">～</span>
            <input v-model="c.max" type="text" inputmode="decimal" placeholder="≤" />
            <button class="mini" title="移除條件" @click="removeCondition(i)">✕</button>
          </div>
        </div>
        <div class="actions">
          <button class="mini" @click="addCondition">＋ 加條件</button>
          <button class="mini" @click="reset">重設</button>
        </div>
        <p class="muted small">
          數字取自每家公司最新一份已下載的 10-K / 10-Q（年初至今、年化，與評分相同）；金額類以百萬為單位、幣別為財報幣別（外國公司可能不是美元）。尚未下載財報的公司不會出現。
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
                <th v-for="f in columns" :key="f.key" class="num sortable" :title="f.name" @click="sortBy(f.key)">
                  {{ f.name.replace(/（.*?）/g, '').replace(/ [①②]|\s*[①②]\/[①②]|\s*[①②]−[①②]/g, '') }}<span v-if="f.unit === '百萬'" class="muted"> 百萬</span>{{ arrow(f.key) }}
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
                <td v-for="f in columns" :key="f.key" class="num" :class="{ neg: r.values[f.key] < 0 }">{{ fmt(f, r.values[f.key]) }}</td>
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
</style>
