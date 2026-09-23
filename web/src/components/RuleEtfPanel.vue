<script setup>
// What a rule ETF has instead of a constituent table: the filters it ran,
// every day the holdings changed, and the companies it has ever held.
// Nothing here is editable - the filters are the fund (see baskets.js).
import { computed, ref } from 'vue';
import { t } from '../i18n';

const props = defineProps({
  result: { type: Object, default: null }, // the ruleEtf response
  label: { type: String, default: '' }, // the filters, as the screener words them
});
const emit = defineEmits(['open']);

const LOG_PAGE = 120;
const logAll = ref(false);
const nameOf = computed(() => Object.fromEntries((props.result?.members || []).map((m) => [m.ticker, m.name])));
const perf = computed(() => Object.fromEntries((props.result?.constituents || []).map((c) => [c.symbol, c])));
// newest first: what changed last is what the user is looking for
const log = computed(() => [...(props.result?.events || [])].reverse());
const shownLog = computed(() => (logAll.value ? log.value : log.value.slice(0, LOG_PAGE)));
const held = computed(() => props.result?.holding ?? 0); // what it really holds
const picked = computed(() => props.result?.events?.at(-1)?.n ?? 0); // what the filters picked
// average number of holdings, weighted by how long it was held
const avgHeld = computed(() => {
  const c = props.result?.counts || [];
  if (!c.length || !props.result?.end) return null;
  const day = (d) => Date.parse(d);
  let sum = 0;
  let span = 0;
  for (let i = 0; i < c.length; i++) {
    const width = (day(c[i + 1]?.date || props.result.end) - day(c[i].date)) / 86400000 || 1;
    sum += c[i].n * width;
    span += width;
  }
  return span ? sum / span : null;
});
const maxHeld = computed(() => (props.result?.counts || []).reduce((m, c) => Math.max(m, c.n), 0));

const sortKey = ref('days');
const sortDir = ref(-1);
function sortBy(k) {
  if (sortKey.value === k) sortDir.value = -sortDir.value;
  else {
    sortKey.value = k;
    sortDir.value = k === 'ticker' || k === 'name' || k === 'first' ? 1 : -1;
  }
}
const arrow = (k) => (sortKey.value === k ? (sortDir.value > 0 ? ' ▲' : ' ▼') : '');
const members = computed(() => {
  const k = sortKey.value;
  const val = (m) => {
    const p = perf.value[m.ticker];
    if (k === 'ticker') return m.ticker;
    if (k === 'name') return m.name || '';
    if (k === 'spells') return m.spans.length;
    if (k === 'first') return m.spans[0]?.from || '';
    if (k === 'days') return p?.days ?? -1;
    if (k === 'return') return p?.return ?? null;
    return '';
  };
  return [...(props.result?.members || [])].sort((a, b) => {
    const x = val(a) ?? -Infinity;
    const y = val(b) ?? -Infinity;
    if (x === y) return a.ticker < b.ticker ? -1 : 1;
    return (x < y ? -1 : 1) * sortDir.value;
  });
});

const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
const cls = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
// an open-ended stretch runs to today, or to the end of the window when one was asked for
const openEnd = computed(() => (props.result?.window?.to ? props.result.end || props.result.window.to : t('rule.now')));
const spanText = (m) => m.spans.map((s) => `${s.from} ～ ${s.to || openEnd.value}`).join(t('sep'));
</script>

<template>
  <div v-if="result" class="rule">
    <div class="panel summary">
      <div class="head">
        <b>{{ t('rule.title') }}</b>
        <span class="mono small filters">{{ label }}</span>
      </div>
      <div class="figs">
        <div :title="result.window?.from || result.window?.to ? t('rule.windowTitle') : ''"><span class="muted small">{{ t('rule.span') }}</span><b class="mono">{{ result.start || '—' }} ～ {{ result.end || '—' }}<span v-if="result.window?.from || result.window?.to" class="muted small"> {{ t('rule.windowed') }}</span></b></div>
        <div :title="picked !== held ? t('rule.pickedTitle', { n: picked }) : ''"><span class="muted small">{{ t('rule.holdingNow') }}</span><b class="mono">{{ held }}<span v-if="picked !== held" class="muted small"> / {{ picked }}</span></b></div>
        <div><span class="muted small">{{ t('rule.everHeld') }}</span><b class="mono">{{ result.members.length }}</b></div>
        <div :title="t('rule.avgHeldTitle')"><span class="muted small">{{ t('rule.avgHeld') }}</span><b class="mono">{{ avgHeld == null ? '—' : avgHeld.toFixed(1) }}</b></div>
        <div><span class="muted small">{{ t('rule.maxHeld') }}</span><b class="mono">{{ maxHeld }}</b></div>
        <div :title="t('rule.changesTitle')"><span class="muted small">{{ t('rule.changes') }}</span><b class="mono">{{ result.events.length }}</b></div>
        <div :title="t('rule.testedTitle')"><span class="muted small">{{ t('rule.tested') }}</span><b class="mono">{{ (result.tested || 0).toLocaleString() }}</b></div>
      </div>
      <p v-if="result.skipped?.length" class="note warnbox small">{{ t('rule.skipped', { list: result.skipped.join(t('sep')) }) }}</p>
      <p class="note muted small">{{ t('rule.howNote') }}</p>
      <p class="note muted small">{{ t('rule.biasNote') }}</p>
    </div>

    <div class="panel wrap log">
      <div class="ghead">
        <b>{{ t('rule.logTitle') }}</b>
        <span class="muted small">{{ t('rule.logHint') }}</span>
        <button v-if="log.length > LOG_PAGE" class="mini" @click="logAll = !logAll">{{ logAll ? t('rule.logLess') : t('rule.logAll', { n: log.length }) }}</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>{{ t('rule.date') }}</th>
            <th class="add">{{ t('rule.added') }}</th>
            <th class="drop">{{ t('rule.dropped') }}</th>
            <th class="num">{{ t('rule.after') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in shownLog" :key="e.date">
            <td class="mono">{{ e.date }}<span v-if="e.opening" class="muted small opening">{{ t('rule.opening') }}</span></td>
            <td class="add">
              <span v-for="s in e.add" :key="s" class="chip in" :title="nameOf[s]" @click="emit('open', { ticker: s })">{{ s }}</span>
              <span v-if="!e.add.length" class="muted">—</span>
            </td>
            <td class="drop">
              <span v-for="s in e.drop" :key="s" class="chip out" :title="nameOf[s]" @click="emit('open', { ticker: s })">{{ s }}</span>
              <span v-if="!e.drop.length" class="muted">—</span>
            </td>
            <td class="num mono">{{ e.n }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!log.length" class="empty muted">{{ t('rule.logEmpty') }}</p>
    </div>

    <div class="panel wrap">
      <div class="ghead"><b>{{ t('rule.membersTitle') }}</b> <span class="muted small">{{ t('rule.membersHint') }}</span></div>
      <table>
        <thead>
          <tr>
            <th class="sortable" @click="sortBy('ticker')">{{ t('col.ticker') }}{{ arrow('ticker') }}</th>
            <th class="sortable" @click="sortBy('name')">{{ t('col.company') }}{{ arrow('name') }}</th>
            <th class="sortable hide-p" @click="sortBy('first')">{{ t('rule.firstIn') }}{{ arrow('first') }}</th>
            <th class="hide-t">{{ t('rule.spans') }}</th>
            <th class="num sortable" @click="sortBy('spells')">{{ t('rule.spells') }}{{ arrow('spells') }}</th>
            <th class="num sortable" :title="t('rule.daysTitle')" @click="sortBy('days')">{{ t('rule.days') }}{{ arrow('days') }}</th>
            <th class="num sortable" :title="t('rule.returnTitle')" @click="sortBy('return')">{{ t('rule.return') }}{{ arrow('return') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in members" :key="m.ticker" class="row" @click="emit('open', { ticker: m.ticker, cik: m.cik, name: m.name })">
            <td class="mono"><a :href="`?company=${m.ticker}`" @click.prevent>{{ m.ticker }}</a></td>
            <td class="name">{{ m.name }}</td>
            <td class="mono hide-p">{{ m.spans[0]?.from || '—' }}</td>
            <td class="small muted hide-t spans">{{ spanText(m) }}</td>
            <td class="num mono">{{ m.spans.length }}</td>
            <td class="num mono">{{ perf[m.ticker]?.days ?? '—' }}</td>
            <td class="num mono" :class="cls(perf[m.ticker]?.return)">{{ pct(perf[m.ticker]?.return) }}</td>
            <td class="small">
              <span v-if="perf[m.ticker]?.wild" class="warn wild" :title="t('rule.wildTitle', { date: perf[m.ticker].wild.date, factor: perf[m.ticker].wild.factor.toFixed(1) })">{{ t('rule.wild') }}</span>
              <span v-if="perf[m.ticker]?.cheap" class="warn" :title="t('rule.cheapTitle', { n: perf[m.ticker].cheap, price: result.minPrice })">{{ t('rule.cheap') }}</span>
              <span v-else-if="perf[m.ticker]?.in" class="tag in">{{ t('rule.inNow') }}</span>
              <span v-else-if="perf[m.ticker]?.delisted" class="warn">{{ t('rule.delisted') }}</span>
              <span v-else-if="!perf[m.ticker]" class="warn">{{ t('rule.noBars') }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.rule {
  display: grid;
  gap: 12px;
}
.summary .head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.filters {
  color: var(--muted);
}
.figs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
}
.figs div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.figs b {
  font-size: 15px;
}
.note {
  margin: 10px 0 0;
}
.warnbox {
  border: 1px solid var(--neg);
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--neg);
}
.ghead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 2px 8px;
  flex-wrap: wrap;
}
.wrap {
  overflow: auto;
  max-height: 520px;
}
table {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
}
th,
td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  text-align: left;
  vertical-align: top;
}
thead th {
  position: sticky;
  top: 0;
  background: var(--panel);
  z-index: 1;
  font-weight: 600;
  border-bottom: 2px solid var(--border);
  font-size: 13px;
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
.small {
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.name {
  white-space: normal;
  min-width: 180px;
}
.spans {
  white-space: normal;
  max-width: 320px;
}
.row {
  cursor: pointer;
}
.row:hover td {
  background: var(--accent-soft);
}
tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
td.add,
td.drop {
  white-space: normal;
  max-width: 45%;
}
.chip {
  display: inline-block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  padding: 1px 5px;
  margin: 1px 3px 1px 0;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid transparent;
}
.chip.in {
  color: var(--pos);
  border-color: var(--pos);
}
.opening {
  margin-left: 6px;
}
.chip.out {
  color: var(--neg);
  border-color: var(--neg);
}
.chip:hover {
  background: var(--accent-soft);
}
.tag {
  display: inline-block;
  font-size: 10px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 3px;
  padding: 0 3px;
}
.warn {
  color: var(--muted);
  font-size: 11px;
}
.warn.wild {
  color: var(--neg);
}
.up {
  color: var(--pos);
}
.down {
  color: var(--neg);
}
.empty {
  padding: 18px;
  text-align: center;
}
@media (max-width: 760px) {
  .wrap {
    max-height: none;
  }
  th,
  td {
    padding: 4px 6px;
  }
}
</style>
