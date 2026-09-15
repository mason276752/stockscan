<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';

const props = defineProps({
  data: { type: Object, required: true }, // /api/company/:id/indicators response
  annualizeAmounts: { type: Boolean, default: true },
});

const fmt = (digits) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const F = { pct: fmt(2), times: fmt(2), days: fmt(1), eps: fmt(2), amount: fmt(0) };

function rawValue(row, col) {
  let v = col.values[row.key];
  if (row.kind === 'flow' && props.annualizeAmounts && quarterMode.value) v = col.flowsAnnualized[row.key];
  if (v == null || Number.isNaN(v) || !Number.isFinite(v)) return null;
  return v;
}

// hovered row: colour each cell by the row's benchmark (green passes, red fails)
const hoverKey = ref(null);
const OPS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b };
const OP_TEXT = { '>': '>', '>=': '≥', '<': '<', '<=': '≤' };
function benchmarkText(row) {
  if (!row.benchmark) return '';
  const unit = row.unit === '百萬' ? '' : row.unit === '%' ? '%' : ` ${row.unit}`;
  return `${OP_TEXT[row.benchmark.op]} ${row.benchmark.value}${unit}`;
}
function verdict(row, col) {
  if (hoverKey.value !== row.key || !row.benchmark) return '';
  const v = rawValue(row, col);
  if (v == null) return '';
  return OPS[row.benchmark.op](v, row.benchmark.value) ? 'good' : 'bad';
}

function cell(row, col) {
  const v = rawValue(row, col);
  if (v == null) return { text: '—', neg: false };
  let text;
  switch (row.unit) {
    case '%':
      text = F.pct.format(v);
      break;
    case '次':
      text = F.times.format(v);
      break;
    case '天':
      text = F.days.format(v);
      break;
    case '元':
      text = F.eps.format(v);
      break;
    default:
      text = F.amount.format(v / 1e6);
  }
  return { text, neg: v < 0 };
}

function cellTitle(row, col) {
  if (row.key === 'cfAdequacy' && col.values.cfAdequacyPeriods) return `以最近 ${col.values.cfAdequacyPeriods} ${props.data.quarterly ? '季' : '年'}計算`;
  if (col.missing) return props.data.mode === 'year' && props.data.quarterly ? '這一年有季度缺 Inline XBRL 申報' : '此期沒有 Inline XBRL 申報';
  return '';
}

// rows grouped for the rowspan "類別" column
const groups = computed(() => {
  const out = [];
  for (const r of props.data.rows) {
    const g = out[out.length - 1];
    if (g && g.name === r.group) g.rows.push(r);
    else out.push({ name: r.group, rows: [r] });
  }
  return out;
});

const basisLabel = computed(() => (props.data.basis === 'ttm' ? '近四季合計' : props.data.basis === 'x4' ? '單季 ×4' : '年度'));
const quarterMode = computed(() => props.data.quarterly && (props.data.mode === 'quarter' || props.data.mode === 'same'));

// newest quarter (the one the user picked) is on the far right: start there
const wrap = ref(null);
function scrollToEnd() {
  nextTick(() => {
    if (wrap.value) wrap.value.scrollLeft = wrap.value.scrollWidth;
  });
}
onMounted(scrollToEnd);
watch(() => props.data, scrollToEnd);

const tip = ref(null);
function showTip(row, e) {
  tip.value = { row, x: e.clientX, y: e.clientY };
}
function hideTip() {
  tip.value = null;
}
const tipStyle = computed(() => {
  if (!tip.value) return {};
  const w = 380;
  const x = Math.min(tip.value.x + 16, window.innerWidth - w - 12);
  const below = tip.value.y < window.innerHeight * 0.6;
  return below ? { left: `${x}px`, top: `${tip.value.y + 18}px`, width: `${w}px` } : { left: `${x}px`, bottom: `${window.innerHeight - tip.value.y + 12}px`, width: `${w}px` };
});
</script>

<template>
  <div ref="wrap" class="wrap">
    <table>
      <thead>
        <tr>
          <th class="group">類別</th>
          <th class="name">財務比率</th>
          <th v-for="c in data.columns" :key="c.label" class="num" :class="{ missing: c.missing }" :title="c.periodEnd ? `期末 ${c.periodEnd}` : ''">
            <div>{{ c.label }}</div>
            <div class="muted end">{{ c.sublabel || c.periodEnd || '無資料' }}</div>
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="g in groups" :key="g.name">
          <tr v-for="(row, i) in g.rows" :key="row.key" :class="{ first: i === 0, flow: row.kind === 'flow', hover: hoverKey === row.key }" @mouseenter="hoverKey = row.key" @mouseleave="hoverKey = null">
            <td v-if="i === 0" class="group" :rowspan="g.rows.length">{{ g.name }}</td>
            <td class="name" @mouseenter="showTip(row, $event)" @mouseleave="hideTip">
              {{ row.name }}
              <span class="unit muted">{{ row.unit === '百萬' ? '百萬' : row.unit }}</span>
              <span v-if="row.annualized && quarterMode" class="badge" :title="`分子為 ${basisLabel}`">年化</span>
              <span v-else-if="row.kind === 'flow' && annualizeAmounts && quarterMode" class="badge">{{ basisLabel }}</span>
              <span v-if="row.benchmark" class="bench muted" :title="`標準：${benchmarkText(row)}`">{{ benchmarkText(row) }}</span>
            </td>
            <td v-for="c in data.columns" :key="c.label" class="num" :class="[{ neg: cell(row, c).neg, missing: c.missing }, verdict(row, c)]" :title="cellTitle(row, c)">
              {{ cell(row, c).text }}
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <Teleport to="body">
      <div v-if="tip" class="tip" :style="tipStyle">
        <div class="tip-en">{{ tip.row.name }}</div>
        <div class="tip-doc">{{ tip.row.formula }}</div>
        <div v-if="tip.row.benchmark" class="tip-doc">標準：{{ benchmarkText(tip.row) }}（符合的格子綠底、不符合紅底）</div>
        <div v-if="tip.row.annualized && quarterMode" class="tip-doc">年化方式：{{ basisLabel }}；平均餘額 = (本季末 + 上季末) ÷ 2</div>
        <div v-else-if="tip.row.annualized && data.mode === 'year' && data.quarterly" class="tip-doc">流量為四季合計；平均餘額 = (期末 + 四季前期末) ÷ 2</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.wrap {
  overflow: auto;
  max-height: calc(100vh - 220px);
  border: 1px solid var(--border);
  border-radius: 8px;
}
table {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
}
th,
td {
  padding: 5px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--panel);
  text-align: right;
  font-weight: 600;
  border-bottom: 2px solid var(--border);
}
thead th .end {
  font-weight: normal;
  font-size: 11px;
}
th.group,
td.group {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--total);
  text-align: center;
  font-weight: 600;
  width: 90px;
  min-width: 90px;
  max-width: 90px;
  white-space: normal;
  border-right: 1px solid var(--border);
  vertical-align: middle;
}
th.name,
td.name {
  position: sticky;
  left: 90px; /* = the 類別 column's border-box width */
  z-index: 1;
  background: var(--panel);
  text-align: left;
  min-width: 250px;
  border-right: 1px solid var(--border);
  cursor: help;
}
thead th.group,
thead th.name {
  z-index: 3;
}
td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
td.neg {
  color: var(--neg);
}
tr.hover td {
  background: var(--row-alt);
}
tr.hover td.name {
  background: var(--accent-soft);
}
td.good {
  background: #dcfce7 !important;
}
td.bad {
  background: #fee2e2 !important;
}
.bench {
  font-size: 11px;
  margin-left: 6px;
}
.missing {
  color: var(--muted);
}
tr.first td {
  border-top: 2px solid var(--border);
}
tr.flow td.name {
  color: var(--muted);
}
.unit {
  font-size: 11px;
  margin-left: 4px;
}
.badge {
  font-size: 10px;
  color: var(--accent);
  border: 1px dashed var(--accent);
  border-radius: 3px;
  padding: 0 3px;
  margin-left: 4px;
  vertical-align: middle;
}
</style>
