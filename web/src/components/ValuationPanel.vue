<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { PropType } from 'vue';
import { MODELS, impliedPrice, multiplesAt, runModels } from '../../../shared/valuation.ts';
import type { MultipleDef, ValuationAssumptions } from '../../../shared/valuation.ts';
import type { Valuation } from '../../../server/lib/valuation.ts';
import { bigMoney, bigShares, dateLocale, t, tr } from '../i18n';

/** The assumptions as the inputs hold them: percentages, not fractions. */
interface AssumptionInputs {
  r: number;
  g1: number;
  gT: number;
  years: number;
  taxRate: number;
  aaaYield: number | null;
  gGraham: number | null;
}

const props = defineProps({
  data: { type: Object as PropType<Valuation>, required: true }, // /api/company/:id/valuation response
  adr: { type: Number, default: 1 }, // ordinary shares per listed share (ADR ratio)
});
const emit = defineEmits(['update:adr']);
const adrInput = ref(String(props.adr));
watch(adrInput, (v) => {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0 && n !== props.adr) emit('update:adr', n);
});
const foreign = computed(() => props.data.currency && props.data.currency.reporting !== props.data.currency.quote);

// ---- price basis: the chosen filing's period end (default), its filing
// date, today's quote, or a price typed in by the user ----
// the newest filing defaults to today's price; an older one to its own period end
const basis = ref(props.data.isLatest ? 'now' : 'periodEnd'); // periodEnd | filingDate | now
const priceInput = ref('');
watch(
  () => props.data,
  (d) => {
    basis.value = d.isLatest ? 'now' : 'periodEnd';
    priceInput.value = '';
  },
);
const latest = computed(() => props.data.columns[props.data.columns.length - 1] || null);
const typedPrice = computed(() => {
  const n = Number(priceInput.value);
  return priceInput.value !== '' && Number.isFinite(n) && n > 0 ? n : null;
});
const basisPrice = computed(() => {
  if (basis.value === 'now') return props.data.quote?.price ?? null;
  if (basis.value === 'filingDate') return latest.value?.priceAtFiling ?? null;
  return latest.value?.price ?? null;
});
const price = computed(() => typedPrice.value ?? basisPrice.value);
const basisDate = computed(() => {
  if (basis.value === 'now') return props.data.quote?.date || (props.data.quote?.time ? new Date(props.data.quote.time).toLocaleString(dateLocale.value) : '');
  if (basis.value === 'filingDate') return latest.value?.priceAtFilingDate || latest.value?.filingDate || '';
  return latest.value?.priceDate || latest.value?.periodEnd || '';
});
const basisLabel = computed(() => (basis.value === 'now' ? t('vp.basisNow') : basis.value === 'filingDate' ? t('meta.filingDate') : t('vp.basisPeriodEnd')));
// per-share figures matching the basis: period-end FX for historical prices, today's FX for the quote
const nowPs = computed(() => (basis.value === 'now' ? props.data.nowPerShare : latest.value?.perShareQuote) || null);
const nowNetDebt = computed(() => (nowPs.value ? (nowPs.value.debtps ?? 0) - (nowPs.value.cashps ?? 0) : null));
const nowMultiples = computed(() => (nowPs.value && price.value != null ? multiplesAt(price.value, nowPs.value, nowNetDebt.value) : {}));
const marketCap = computed(() => (latest.value?.shares && price.value != null ? (price.value * latest.value.shares) / (props.data.currency?.adr || 1) : null));

// ---- assumptions for the absolute models (editable, in %) ----
const a = ref<AssumptionInputs>({} as AssumptionInputs);
function resetAssumptions() {
  const d = props.data.assumptions;
  const p = (x: number) => Math.round(x * 1000) / 10;
  a.value = { r: p(d.r), g1: p(d.g1), gT: p(d.gT), years: d.years, taxRate: p(d.taxRate!), aaaYield: d.aaaYield ?? null, gGraham: d.gGraham ?? null };
}
watch(() => props.data, resetAssumptions, { immediate: true });
const assumptions = computed((): ValuationAssumptions => ({
  r: a.value.r / 100,
  g1: a.value.g1 / 100,
  gT: a.value.gT / 100,
  years: Math.max(1, Math.round(a.value.years || 5)),
  taxRate: a.value.taxRate / 100,
  aaaYield: a.value.aaaYield,
  gGraham: a.value.gGraham,
}));
const modelInputs = computed(() => (props.data.inputs && nowPs.value ? { ...props.data.inputs, ...nowPs.value, taxRate: assumptions.value.taxRate } : null));
const absolute = computed(() => (modelInputs.value ? runModels(modelInputs.value, assumptions.value) : {}));

// ---- formatting ----
const f2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const money = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : f2.format(v));
const mult = (def: { unit?: string }, v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : def.unit === '%' ? `${f2.format(v)}%` : `${f1.format(v)}×`);
const pctOf = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${f1.format(v * 100)}%`);

// relative to the current price: for price/EV multiples lower is cheaper, for yields higher is cheaper
function cheapness(def: MultipleDef, current: number | null | undefined, avg: number | null | undefined) {
  if (current == null || avg == null) return '';
  const cheaper = def.kind === 'yield' ? current > avg : current < avg;
  return cheaper ? 'good' : 'bad';
}
function upside(v: number | null | undefined) {
  if (v == null || price.value == null) return null;
  return v / price.value - 1;
}
const fair = (def: MultipleDef, m: number | null | undefined) => (nowPs.value ? impliedPrice(def, m, nowPs.value, nowNetDebt.value) : null);

const inputRows = computed(() => {
  const i = modelInputs.value;
  if (!i) return [];
  return [
    [t('vp.in.eps'), money(i.eps)],
    [t('vp.in.bvps'), money(i.bvps)],
    [t('vp.in.tbvps'), money(i.tbvps)],
    [t('vp.in.dps'), money(i.dps)],
    [t('vp.in.ocfps'), money(i.ocfps)],
    [t('vp.in.fcfps'), money(i.fcfps)],
    [t('vp.in.ebitps'), money(i.ebitps)],
    [t('vp.in.daps'), money(i.daps)],
    [t('vp.in.cashps'), money(i.cashps)],
    [t('vp.in.debtps'), money(i.debtps)],
    [t('vp.in.payout'), i.payout == null ? '—' : `${f1.format(i.payout * 100)}%`],
    [t('vp.in.roe'), i.roe == null ? '—' : `${f1.format(i.roe * 100)}%`],
  ];
});
const growthRows = computed(() => {
  const g = props.data.growth;
  if (!g) return [];
  const p = (v: number | null | undefined) => (v == null ? '—' : `${f1.format(v * 100)}%`);
  return [
    [t('vp.g.revenue'), p(g.revenue)],
    ['EPS', p(g.eps)],
    [t('vp.g.fcf'), p(g.fcf)],
    [t('vp.g.dps'), p(g.dps)],
    [t('vp.in.bvps'), p(g.bvps)],
  ];
});

// history table scrolls to the newest column
const wrap = ref<HTMLElement | null>(null);
const scrollToEnd = () => nextTick(() => wrap.value && (wrap.value.scrollLeft = wrap.value.scrollWidth));
onMounted(scrollToEnd);
watch(() => props.data, scrollToEnd);

// tooltips (teleported, like the other tables)
const tip = ref<{ title: string; text: string; x: number; y: number } | null>(null);
const showTip = (title: string, text: string, e: MouseEvent) => (tip.value = { title, text, x: e.clientX, y: e.clientY });
const hideTip = () => (tip.value = null);
const tipStyle = computed((): Record<string, string> => {
  if (!tip.value) return {};
  const w = 380;
  const x = Math.min(tip.value.x + 16, window.innerWidth - w - 12);
  const below = tip.value.y < window.innerHeight * 0.6;
  return below ? { left: `${x}px`, top: `${tip.value.y + 18}px`, width: `${w}px` } : { left: `${x}px`, bottom: `${window.innerHeight - tip.value.y + 12}px`, width: `${w}px` };
});
</script>

<template>
  <div class="val">
    <div class="panel head">
      <div>
        <div class="price">
          <span class="big">{{ price == null ? '—' : `$${money(price)}` }}</span>
          <span v-if="typedPrice != null" class="muted small">{{ t('vp.customPrice') }}</span>
          <span v-else-if="price != null" class="muted small">{{ t('vp.closeOf', { basis: basisLabel, date: basisDate }) }} · {{ data.quote?.source || data.priceHistory?.source }}</span>
          <span v-else class="error-inline">{{ t('vp.noPrice', { basis: basisLabel, err: basis === 'now' && data.quote?.error ? `: ${data.quote.error}` : '' }) }}</span>
        </div>
        <div class="muted small basis-line">
          {{ t('vp.basisPeriodEnd') }} {{ latest?.priceDate || '—' }} <b>{{ money(latest?.price) }}</b>
          · {{ t('meta.filingDate') }} {{ latest?.filingDate || '—' }} <b>{{ money(latest?.priceAtFiling) }}</b>
          · {{ t('vp.basisNow') }} <b>{{ money(data.quote?.price) }}</b><span v-if="data.quote?.date">{{ t('vp.closeParen', { date: data.quote.date }) }}</span><span v-else-if="data.quote?.time">（{{ new Date(data.quote.time).toLocaleString(dateLocale) }}）</span>
        </div>
        <div class="muted small">
          {{ t('vp.marketCap') }} {{ bigMoney(marketCap) }} · {{ t('vp.shares') }} {{ bigShares(latest?.shares) }}<span v-if="latest?.sharesSource === 'diluted'">{{ t('vp.sharesDiluted') }}</span><span v-else-if="latest?.shares && latest?.periodEnd">{{ t('vp.sharesCover', { date: latest.periodEnd }) }}</span>
          · {{ t('vp.ttmTo') }} {{ latest?.periodEnd || '—' }}
          <template v-if="foreign && data.currency.fxMissing"> · <span class="error-inline">{{ t('vp.fxMissing', { reporting: data.currency.reporting, quote: data.currency.quote }) }}</span></template>
          <template v-else-if="foreign"> · {{ t('vp.fx', { reporting: data.currency.reporting, source: data.currency.fxSource, rate: data.currency.fxNow.toFixed(4), quote: data.currency.quote }) }}</template>
          · {{ t('vp.history') }} {{ data.priceHistory?.source || '—' }} {{ data.priceHistory?.from || '—' }} ～ {{ data.priceHistory?.to || '—' }}<span v-if="data.priceHistory?.splits?.length">{{ t(data.priceHistory.splitsInferred ? 'vp.splitsInferred' : 'vp.splits', { list: data.priceHistory.splits.map((s) => `${s.date} ${s.ratio}:1`).join(t('sep')) }) }}</span><span v-else-if="data.priceHistory?.splitsInferred">{{ t('vp.splitsNoneInferred') }}</span><span v-if="data.priceHistory?.eventsError" class="error-inline">{{ t('vp.splitsError', { err: data.priceHistory.eventsError }) }}</span><span v-if="data.priceHistory?.headMissing" class="error-inline">{{ t('vp.headMissing', { to: data.priceHistory.to }) }}</span>
        </div>
      </div>
      <div class="controls">
        <label class="small" :title="t('vp.basisTitle')">
          {{ t('vp.basis') }}
          <select v-model="basis">
            <option value="periodEnd">{{ t('vp.basisPeriodEnd') }}</option>
            <option value="filingDate">{{ t('meta.filingDate') }}</option>
            <option value="now">{{ t('vp.basisNowClose') }}</option>
          </select>
        </label>
        <label v-if="foreign" class="small" :title="t('vp.adrTitle')">
          {{ t('vp.adr') }}
          <input v-model="adrInput" type="text" inputmode="decimal" class="price-input short" />
          <span v-if="props.adr === 1" class="error-inline">{{ t('vp.adrHint') }}</span>
        </label>
        <label class="small">
          {{ t('vp.custom') }}
          <input v-model="priceInput" type="text" inputmode="decimal" :placeholder="t('vp.customPlaceholder')" class="price-input" />
        </label>
      </div>
    </div>

    <!-- ===== relative ===== -->
    <h3>{{ t('vp.relative') }} <span class="muted small">— {{ t('vp.relativeSub', { basis: basisLabel, n: data.columns.length, unit: data.quarterly ? t('vp.quartersUnit') : t('vp.yearsUnit') }) }}</span></h3>
    <div class="wrap">
      <table class="summary">
        <thead>
          <tr>
            <th class="name">{{ t('vp.multiple') }}</th>
            <th class="num">{{ basisLabel }}</th>
            <th class="num">{{ t('vp.avg') }}</th>
            <th class="num">{{ t('vp.median') }}</th>
            <th class="num">{{ t('vp.min') }}</th>
            <th class="num">{{ t('vp.max') }}</th>
            <th class="num">{{ t('vp.fairAvg') }}</th>
            <th class="num">{{ t('vp.fairMedian') }}</th>
            <th class="num">{{ t('vp.cheap') }}</th>
            <th class="num">{{ t('vp.dear') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in data.summary" :key="s.key">
            <td class="name" @mouseenter="showTip(tr(s.name), tr(s.formula), $event)" @mouseleave="hideTip">{{ tr(s.name) }}</td>
            <td class="num" :class="cheapness(s, nowMultiples[s.key], s.avg)">{{ mult(s, nowMultiples[s.key]) }}</td>
            <td class="num">{{ mult(s, s.avg) }}</td>
            <td class="num">{{ mult(s, s.median) }}</td>
            <td class="num">{{ mult(s, s.min) }}</td>
            <td class="num">{{ mult(s, s.max) }}</td>
            <td class="num" :class="{ good: upside(fair(s, s.avg))! > 0, bad: upside(fair(s, s.avg))! < 0 }" :title="t('vp.vsPrice', { pct: pctOf(upside(fair(s, s.avg))) })">{{ money(fair(s, s.avg)) }}</td>
            <td class="num" :title="t('vp.vsPrice', { pct: pctOf(upside(fair(s, s.median))) })">{{ money(fair(s, s.median)) }}</td>
            <td class="num">{{ money(fair(s, s.kind === 'yield' ? s.max : s.min)) }}</td>
            <td class="num">{{ money(fair(s, s.kind === 'yield' ? s.min : s.max)) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted small note">{{ t('vp.relativeNote', { basis: basisLabel, price: money(price) }) }}</p>

    <div ref="wrap" class="wrap">
      <table class="history">
        <thead>
          <tr>
            <th class="name">{{ t('vp.periods') }}</th>
            <th v-for="c in data.columns" :key="c.label" class="num" :title="c.periodEnd ? t('vp.periodTitle', { end: c.periodEnd, date: c.priceDate || '—' }) : ''">
              <div>{{ c.label }}</div>
              <div class="muted end">{{ c.periodEnd }}</div>
            </th>
            <th class="num now">{{ basisLabel }}</th>
          </tr>
        </thead>
        <tbody>
          <tr class="flow">
            <td class="name">{{ t('vp.rowPrice') }}</td>
            <td v-for="c in data.columns" :key="c.label" class="num">{{ money(c.price) }}</td>
            <td class="num now">{{ money(price) }}</td>
          </tr>
          <tr class="flow">
            <td class="name">{{ t('vp.rowEps') }}{{ foreign ? t('vp.perAdr', { quote: data.currency.quote }) : '' }}</td>
            <td v-for="c in data.columns" :key="c.label" class="num">{{ money(c.perShareQuote.eps) }}</td>
            <td class="num now">{{ money(nowPs?.eps) }}</td>
          </tr>
          <tr class="flow">
            <td class="name">{{ t('vp.in.bvps') }}{{ foreign ? t('vp.perAdr', { quote: data.currency.quote }) : '' }}</td>
            <td v-for="c in data.columns" :key="c.label" class="num">{{ money(c.perShareQuote.bvps) }}</td>
            <td class="num now">{{ money(nowPs?.bvps) }}</td>
          </tr>
          <tr class="flow">
            <td class="name">{{ t('vp.rowFcf') }}</td>
            <td v-for="c in data.columns" :key="c.label" class="num">{{ money(c.perShareQuote.fcfps) }}</td>
            <td class="num now">{{ money(nowPs?.fcfps) }}</td>
          </tr>
          <tr v-for="m in data.multiples" :key="m.key">
            <td class="name" @mouseenter="showTip(tr(m.name), tr(m.formula), $event)" @mouseleave="hideTip">{{ tr(m.name) }}</td>
            <td v-for="c in data.columns" :key="c.label" class="num">{{ mult(m, c.multiples[m.key]) }}</td>
            <td class="num now">{{ mult(m, nowMultiples[m.key]) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ===== absolute ===== -->
    <h3>{{ t('vp.absolute') }} <span class="muted small">— {{ t('vp.absoluteSub', { basis: basisLabel }) }}</span></h3>
    <div class="abs">
      <div class="panel assumptions">
        <div class="muted small head-row">{{ t('vp.assumptions') }} <button class="mini" @click="resetAssumptions">{{ t('vp.resetDefaults') }}</button></div>
        <label>{{ t('vp.a.r') }} <input v-model.number="a.r" type="number" step="0.5" /> %</label>
        <label>{{ t('vp.a.g1') }} <input v-model.number="a.g1" type="number" step="0.5" /> %</label>
        <label>{{ t('vp.a.years') }} <input v-model.number="a.years" type="number" step="1" min="1" max="20" /> {{ t('vp.yearsUnit') }}</label>
        <label>{{ t('vp.a.gT') }} <input v-model.number="a.gT" type="number" step="0.5" /> %</label>
        <label>{{ t('vp.a.tax') }} <input v-model.number="a.taxRate" type="number" step="1" /> %</label>
        <label>{{ t('vp.a.aaa') }} <input v-model.number="a.aaaYield" type="number" step="0.1" /> %</label>
        <label>{{ t('vp.a.gGraham') }} <input v-model.number="a.gGraham" type="number" step="0.5" /> %</label>
        <p class="muted small">{{ t('vp.defaults', { years: data.growth?.years ? f1.format(data.growth.years) : '—' }) }}</p>
        <div class="muted small head-row">{{ t('vp.cagr', { years: data.growth?.years ? f1.format(data.growth.years) : '—' }) }}</div>
        <table class="kv">
          <tr v-for="[k, v] in growthRows" :key="k">
            <td>{{ k }}</td>
            <td class="num">{{ v }}</td>
          </tr>
        </table>
      </div>
      <div>
        <div class="wrap">
          <table class="models">
            <thead>
              <tr>
                <th class="name">{{ t('vp.method') }}</th>
                <th class="num">{{ t('vp.valuePerShare') }}</th>
                <th class="num">{{ t('vp.vsBasis', { basis: basisLabel }) }}</th>
                <th>{{ t('vp.description') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in MODELS" :key="m.key">
                <td class="name" @mouseenter="showTip(tr(m.name), tr(m.formula), $event)" @mouseleave="hideTip">{{ tr(m.name) }}</td>
                <td class="num" :class="{ good: upside(absolute[m.key])! > 0, bad: upside(absolute[m.key])! < 0 }">{{ money(absolute[m.key]) }}</td>
                <td class="num" :class="{ good: upside(absolute[m.key])! > 0, bad: upside(absolute[m.key])! < 0 }">{{ pctOf(upside(absolute[m.key])) }}</td>
                <td class="desc muted small">{{ tr(m.formula) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="muted small note">{{ t('vp.absoluteNote', { basis: basisLabel, fx: foreign ? t('vp.absoluteFx') : '' }) }}</p>
        <div class="panel inputs">
          <div class="muted small head-row">{{ t('vp.inputs', { date: latest?.periodEnd || '—' }) }}</div>
          <div class="kvgrid">
            <template v-for="[k, v] in inputRows" :key="k">
              <span class="muted">{{ k }}</span><span class="num">{{ v }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="tip" class="tip" :style="tipStyle">
        <div class="tip-en">{{ tip.title }}</div>
        <div class="tip-doc">{{ tip.text }}</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
h3 {
  font-size: 15px;
  margin: 18px 0 8px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 16px;
}
.price .big {
  font-size: 24px;
  font-weight: 700;
  margin-right: 8px;
}
.price-input {
  width: 110px;
  padding: 5px 8px;
  margin-left: 6px;
}
.price-input.short {
  width: 60px;
}
.controls {
  display: flex;
  gap: 14px;
  align-items: center;
}
.controls select {
  font: inherit;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  margin-left: 4px;
}
.basis-line b {
  font-weight: 600;
  color: var(--text);
}
.error-inline {
  color: var(--neg);
}
.small {
  font-size: 12px;
}
.note {
  margin: 6px 0 12px;
}
.wrap {
  overflow: auto;
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
th.name,
td.name {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--panel);
  text-align: left;
  min-width: 220px;
  border-right: 1px solid var(--border);
  cursor: help;
}
thead th.name {
  z-index: 3;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.now {
  background: var(--accent-soft);
  font-weight: 600;
}
tr.flow td.name {
  color: var(--muted);
  cursor: default;
}
td.good {
  background: var(--good-soft);
}
td.bad {
  background: var(--neg-soft);
}
.abs {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 16px;
  align-items: start;
}
.assumptions,
.inputs {
  padding: 12px 14px;
}
.inputs {
  margin-top: 12px;
}
.assumptions label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  margin: 6px 0;
}
.assumptions input {
  width: 80px;
  font: inherit;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  text-align: right;
  margin-left: auto;
}
.head-row {
  font-weight: 600;
  margin: 6px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.mini {
  font-size: 11px;
  padding: 2px 6px;
}
.kv td {
  padding: 3px 6px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}
.kvgrid {
  display: grid;
  grid-template-columns: auto 1fr auto 1fr;
  gap: 4px 14px;
  font-size: 13px;
}
.kvgrid .num {
  font-variant-numeric: tabular-nums;
}
.models td.desc {
  white-space: normal;
  max-width: 520px;
}
@media (max-width: 900px) {
  .abs {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 760px) {
  th,
  td {
    padding: 4px 7px;
  }
  th.name,
  td.name {
    min-width: 120px;
    max-width: 44vw;
    white-space: normal;
    font-size: 12px;
  }
  .kvgrid {
    grid-template-columns: auto 1fr;
  }
  .models td.desc {
    max-width: 60vw;
    font-size: 11px;
  }
  .head {
    padding: 10px 12px;
  }
  .controls {
    flex-wrap: wrap;
    gap: 8px 14px;
  }
}
</style>
