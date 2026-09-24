<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { t, tr } from '../i18n';

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
  const unit = row.unit === '百萬' ? '' : row.unit === '%' ? '%' : ` ${tr(row.unit)}`;
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
  if (row.key === 'cfAdequacy' && col.values.cfAdequacyPeriods) return t(props.data.quarterly ? 'it.adequacyQ' : 'it.adequacyY', { n: col.values.cfAdequacyPeriods });
  if (col.missing) return props.data.mode === 'year' && props.data.quarterly ? t('it.missingYear') : t('it.missingPeriod');
  return '';
}

// rows grouped for the rowspan group column
const groups = computed(() => {
  const out = [];
  for (const r of props.data.rows) {
    const g = out[out.length - 1];
    if (g && g.name === r.group) g.rows.push(r);
    else out.push({ name: r.group, rows: [r] });
  }
  return out;
});

const basisLabel = computed(() => (props.data.basis === 'ttm' ? t('ind.ttm') : props.data.basis === 'x4' ? t('ind.x4') : t('it.annual')));
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
          <th class="group hide-p">{{ t('it.group') }}</th>
          <th class="name">{{ t('it.ratio') }}</th>
          <th v-for="c in data.columns" :key="c.label" class="num" :class="{ missing: c.missing }" :title="c.periodEnd ? `${t('meta.periodEnd')} ${c.periodEnd}` : ''">
            <div>{{ c.label }}</div>
            <div class="muted end">{{ c.sublabel || c.periodEnd || t('it.noData') }}</div>
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="g in groups" :key="g.name">
          <tr v-for="(row, i) in g.rows" :key="row.key" :class="{ first: i === 0, flow: row.kind === 'flow', hover: hoverKey === row.key }" @mouseenter="hoverKey = row.key" @mouseleave="hoverKey = null">
            <td v-if="i === 0" class="group hide-p" :rowspan="g.rows.length">{{ tr(g.name) }}</td>
            <td class="name" @mouseenter="showTip(row, $event)" @mouseleave="hideTip">
              {{ tr(row.name) }}
              <span class="unit muted">{{ tr(row.unit) }}</span>
              <span v-if="row.annualized && quarterMode" class="badge" :title="t('it.numerator', { basis: basisLabel })">{{ t('it.annualized') }}</span>
              <span v-else-if="row.kind === 'flow' && annualizeAmounts && quarterMode" class="badge">{{ basisLabel }}</span>
              <span v-if="row.benchmark" class="bench muted" :title="`${t('it.benchmark')}${benchmarkText(row)}`">{{ benchmarkText(row) }}</span>
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
        <div class="tip-en">{{ tr(tip.row.name) }}</div>
        <div class="tip-doc">{{ tr(tip.row.formula) }}</div>
        <div v-if="tip.row.benchmark" class="tip-doc">{{ t('it.benchmark') }}{{ benchmarkText(tip.row) }}{{ t('it.benchmarkTip') }}</div>
        <div v-if="tip.row.annualized && quarterMode" class="tip-doc">{{ t('it.annualTipQ', { basis: basisLabel }) }}</div>
        <div v-else-if="tip.row.annualized && data.mode === 'year' && data.quarterly" class="tip-doc">{{ t('it.annualTipY') }}</div>
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
  background: var(--good-soft) !important;
}
td.bad {
  background: var(--neg-soft) !important;
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
@media (max-width: 760px) {
  .wrap {
    max-height: none;
  }
  th,
  td {
    padding: 4px 7px;
  }
  th.name,
  td.name {
    left: 0;
    min-width: 150px;
    max-width: 48vw;
    white-space: normal;
    font-size: 12px;
    line-height: 1.3;
  }
  tr.first td {
    border-top: 2px solid var(--border);
  }
}
</style>
