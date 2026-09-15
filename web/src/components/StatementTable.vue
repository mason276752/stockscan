<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  statement: { type: Object, required: true },
  divisor: { type: Number, default: 1 }, // 1, 1e3, 1e6
  applyNegation: { type: Boolean, default: false },
  showConcept: { type: Boolean, default: false },
  lang: { type: String, default: 'zh' }, // 'zh' | 'en'
});

function displayLabel(item) {
  if (props.lang === 'zh' && item.labelZh) return item.labelZh;
  return item.label || item.concept;
}

// Hover tooltip: English label, concept name and the taxonomy definition.
const tip = ref(null); // { item, x, y }
function showTip(item, e) {
  tip.value = { item, x: e.clientX, y: e.clientY };
}
function moveTip(e) {
  if (tip.value) tip.value = { ...tip.value, x: e.clientX, y: e.clientY };
}
function hideTip() {
  tip.value = null;
}
const tipStyle = computed(() => {
  if (!tip.value) return {};
  const w = 420;
  const x = Math.min(tip.value.x + 16, window.innerWidth - w - 12);
  const below = tip.value.y < window.innerHeight * 0.6;
  return below ? { left: `${x}px`, top: `${tip.value.y + 18}px`, width: `${w}px` } : { left: `${x}px`, bottom: `${window.innerHeight - tip.value.y + 12}px`, width: `${w}px` };
});

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const fmtSmall = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const fmtPerShare = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

function humanize(member) {
  return member
    .split(':')
    .pop()
    .replace(/Member$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

const hasAxes = computed(() => Object.keys(props.statement.axes).length > 0);

const columns = computed(() =>
  props.statement.columns.map((c) => {
    const dims = Object.values(c.dimensions);
    return {
      ...c,
      periodLabel: c.period.instant ? c.period.instant : `${c.period.start} ~ ${c.period.end}`,
      derivedQ4: c.derived && c.label === 'Q4',
      periodKind: c.period.instant ? '時點' : '期間',
      dimLabel: dims.length ? dims.map(humanize).join(' / ') : hasAxes.value ? '合計' : '',
    };
  }),
);

// Only monetary and share counts get scaled; per-share amounts and ratios are shown as-is.
function scalable(unit) {
  return unit && !unit.includes('/') && unit !== 'pure';
}

function display(cell) {
  if (!cell) return { text: '', neg: false };
  if (cell.nil) return { text: '—', neg: false };
  if (typeof cell.value !== 'number') return { text: cell.value ?? cell.raw ?? '', neg: false };
  let v = cell.value;
  if (scalable(cell.unit)) v = v / props.divisor;
  const f = cell.unit?.includes('/') ? fmtPerShare : Math.abs(v) < 1000 && !Number.isInteger(v) ? fmtSmall : fmt;
  return { text: f.format(v), neg: v < 0 };
}

function shown(item, cell) {
  let d = display(cell);
  if (props.applyNegation && item.negated && typeof cell?.value === 'number' && !cell.nil) {
    const v = -(scalable(cell.unit) ? cell.value / props.divisor : cell.value);
    d = { text: fmt.format(v), neg: v < 0 };
  }
  if (cell?.approx) d = { ...d, text: `≈${d.text}` };
  return d;
}

function rowUnit(item) {
  const first = Object.values(item.values)[0];
  return first?.unit || '';
}

function rowClass(item) {
  return {
    abstract: item.abstract,
    total: /total/i.test(item.preferredLabel || ''),
    [`depth-${Math.min(item.depth, 5)}`]: true,
  };
}
</script>

<template>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th class="label">{{ statement.title }}</th>
          <th class="unit">單位</th>
          <th v-for="c in columns" :key="c.id" class="num">
            <div v-if="c.dimLabel" class="dim" :title="Object.values(c.dimensions).join(', ')">{{ c.dimLabel }}</div>
            <div v-if="c.label" class="qlabel">
              {{ c.label }}<span v-if="c.derivedQ4" class="badge" title="FY − Q1 − Q2 − Q3">推算</span>
            </div>
            <div :class="{ small: c.label }">{{ c.periodLabel }}</div>
            <div class="muted kind">{{ c.periodKind }}</div>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(item, i) in statement.lineItems" :key="i" :class="rowClass(item)">
          <td class="label" @mouseenter="showTip(item, $event)" @mousemove="moveTip" @mouseleave="hideTip">
            <div>
              {{ displayLabel(item) }}
              <span v-if="lang === 'zh' && !item.labelZh && !item.abstract" class="muted untranslated" title="尚無中文對照">EN</span>
            </div>
            <div v-if="showConcept" class="mono muted">{{ item.concept }}<span v-if="item.negated"> · negated</span></div>
          </td>
          <td class="unit muted">{{ item.abstract ? '' : rowUnit(item) }}</td>
          <td v-for="c in columns" :key="c.id" class="num" :class="{ neg: shown(item, item.values[c.id]).neg, derived: c.derivedQ4 }">
            {{ shown(item, item.values[c.id]).text }}
          </td>
        </tr>
      </tbody>
    </table>
    <Teleport to="body">
      <div v-if="tip" class="tip" :style="tipStyle">
        <div class="tip-en">{{ tip.item.label || tip.item.concept }}</div>
        <div v-if="tip.item.labelZh && lang !== 'zh'" class="tip-zh">{{ tip.item.labelZh }}</div>
        <div v-if="tip.item.labelStandard && tip.item.labelStandard !== tip.item.label" class="tip-std">{{ tip.item.labelStandard }}</div>
        <div class="tip-concept mono">{{ tip.item.concept }}<span v-if="tip.item.negated"> · 報表顯示時反號</span></div>
        <div v-if="tip.item.descriptionZh" class="tip-desc-zh">{{ tip.item.descriptionZh }}</div>
        <div v-if="tip.item.documentation" class="tip-doc">{{ tip.item.documentation }}</div>
      </div>
    </Teleport>
  </div>
</template>

<style>
/* tooltip is teleported to body, so it is not scoped */
.tip {
  position: fixed;
  z-index: 100;
  background: #1f2933;
  color: #f9fafb;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  pointer-events: none;
  white-space: normal;
}
.tip .tip-en {
  font-weight: 600;
  font-size: 13px;
}
.tip .tip-zh {
  font-weight: 600;
}
.tip .tip-std {
  color: #cbd5e1;
}
.tip .tip-concept {
  color: #93c5fd;
  margin: 4px 0;
  word-break: break-all;
}
.tip .tip-desc-zh {
  margin-top: 4px;
}
.tip .tip-doc {
  color: #cbd5e1;
  margin-top: 4px;
  border-top: 1px solid #374151;
  padding-top: 4px;
}
</style>

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
  min-width: 100%;
}
th,
td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  vertical-align: bottom;
}
thead th {
  position: sticky;
  top: 0;
  background: var(--panel);
  z-index: 2;
  font-weight: 600;
  text-align: right;
  border-bottom: 2px solid var(--border);
}
thead th.label {
  text-align: left;
}
thead th .dim {
  color: var(--accent);
  font-size: 12px;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}
thead th .kind {
  font-weight: normal;
  font-size: 11px;
}
thead th .qlabel {
  font-size: 15px;
}
thead th .small {
  font-weight: normal;
  font-size: 11px;
  color: var(--muted);
}
.badge {
  display: inline-block;
  line-height: 1.3;
  font-size: 10px;
  font-weight: normal;
  color: var(--accent);
  border: 1px dashed var(--accent);
  border-radius: 3px;
  padding: 0 3px;
  margin-left: 4px;
  vertical-align: middle;
}
td.derived {
  background: var(--accent-soft) !important;
}
td.label,
th.label {
  position: sticky;
  left: 0;
  background: var(--panel);
  z-index: 1;
  min-width: 320px;
  max-width: 480px;
  white-space: normal;
}
thead th.label {
  z-index: 3;
}
td.unit,
th.unit {
  font-size: 11px;
  text-align: center;
  min-width: 60px;
}
td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
td.neg {
  color: var(--neg);
}
tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
tr.abstract td.label {
  font-weight: 600;
}
tr.total td {
  background: var(--total) !important;
  font-weight: 600;
}
td.label {
  cursor: help;
}
.untranslated {
  font-size: 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 3px;
  margin-left: 4px;
  vertical-align: middle;
}
tr.depth-1 td.label { padding-left: 10px; }
tr.depth-2 td.label { padding-left: 22px; }
tr.depth-3 td.label { padding-left: 34px; }
tr.depth-4 td.label { padding-left: 46px; }
tr.depth-5 td.label { padding-left: 58px; }
</style>
