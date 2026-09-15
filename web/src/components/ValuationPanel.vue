<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { MODELS, impliedPrice, multiplesAt, runModels } from '../../../shared/valuation.js';

const props = defineProps({
  data: { type: Object, required: true }, // /api/company/:id/valuation response
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
const basis = ref('periodEnd'); // periodEnd | filingDate | now
const priceInput = ref('');
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
  if (basis.value === 'now') return props.data.quote?.time ? new Date(props.data.quote.time).toLocaleString() : '';
  if (basis.value === 'filingDate') return latest.value?.priceAtFilingDate || latest.value?.filingDate || '';
  return latest.value?.priceDate || latest.value?.periodEnd || '';
});
const basisLabel = computed(() => (basis.value === 'now' ? '現在' : basis.value === 'filingDate' ? '申報日' : '所選期末'));
// per-share figures matching the basis: period-end FX for historical prices, today's FX for the quote
const nowPs = computed(() => (basis.value === 'now' ? props.data.nowPerShare : latest.value?.perShareQuote) || null);
const nowNetDebt = computed(() => (nowPs.value ? (nowPs.value.debtps ?? 0) - (nowPs.value.cashps ?? 0) : null));
const nowMultiples = computed(() => (nowPs.value && price.value != null ? multiplesAt(price.value, nowPs.value, nowNetDebt.value) : {}));
const marketCap = computed(() => (latest.value?.shares && price.value != null ? (price.value * latest.value.shares) / (props.data.currency?.adr || 1) : null));

// ---- assumptions for the absolute models (editable, in %) ----
const a = ref({});
function resetAssumptions() {
  const d = props.data.assumptions;
  const p = (x) => Math.round(x * 1000) / 10;
  a.value = { r: p(d.r), g1: p(d.g1), gT: p(d.gT), years: d.years, taxRate: p(d.taxRate), aaaYield: d.aaaYield, gGraham: d.gGraham };
}
watch(() => props.data, resetAssumptions, { immediate: true });
const assumptions = computed(() => ({
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
const f0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const money = (v) => (v == null || !Number.isFinite(v) ? '—' : f2.format(v));
const mult = (def, v) => (v == null || !Number.isFinite(v) ? '—' : def.unit === '%' ? `${f2.format(v)}%` : `${f1.format(v)}×`);
const big = (v) => (v == null ? '—' : v >= 1e12 ? `${f2.format(v / 1e12)} 兆` : v >= 1e8 ? `${f0.format(v / 1e8)} 億` : `${f0.format(v / 1e6)} 百萬`);
const pctOf = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${f1.format(v * 100)}%`);
const shares = (v) => (v == null ? '—' : v >= 1e8 ? `${f2.format(v / 1e8)} 億股` : `${f0.format(v / 1e6)} 百萬股`);

// relative to the current price: for price/EV multiples lower is cheaper, for yields higher is cheaper
function cheapness(def, current, avg) {
  if (current == null || avg == null) return '';
  const cheaper = def.kind === 'yield' ? current > avg : current < avg;
  return cheaper ? 'good' : 'bad';
}
function upside(v) {
  if (v == null || price.value == null) return null;
  return v / price.value - 1;
}
const fair = (def, m) => (nowPs.value ? impliedPrice(def, m, nowPs.value, nowNetDebt.value) : null);

const inputRows = computed(() => {
  const i = modelInputs.value;
  if (!i) return [];
  return [
    ['近四季 EPS（稀釋）', money(i.eps)],
    ['每股淨值', money(i.bvps)],
    ['每股有形淨值', money(i.tbvps)],
    ['每股現金股利（近四季）', money(i.dps)],
    ['每股營業現金流', money(i.ocfps)],
    ['每股自由現金流', money(i.fcfps)],
    ['每股營業利益', money(i.ebitps)],
    ['每股折舊攤銷', money(i.daps)],
    ['每股現金及短期投資', money(i.cashps)],
    ['每股有息負債', money(i.debtps)],
    ['配息率', i.payout == null ? '—' : `${f1.format(i.payout * 100)}%`],
    ['ROE（近四季）', i.roe == null ? '—' : `${f1.format(i.roe * 100)}%`],
  ];
});
const growthRows = computed(() => {
  const g = props.data.growth;
  if (!g) return [];
  const p = (v) => (v == null ? '—' : `${f1.format(v * 100)}%`);
  return [
    ['營業收入', p(g.revenue)],
    ['EPS', p(g.eps)],
    ['自由現金流', p(g.fcf)],
    ['每股股利', p(g.dps)],
    ['每股淨值', p(g.bvps)],
  ];
});

// history table scrolls to the newest column
const wrap = ref(null);
const scrollToEnd = () => nextTick(() => wrap.value && (wrap.value.scrollLeft = wrap.value.scrollWidth));
onMounted(scrollToEnd);
watch(() => props.data, scrollToEnd);

// tooltips (teleported, like the other tables)
const tip = ref(null);
const showTip = (title, text, e) => (tip.value = { title, text, x: e.clientX, y: e.clientY });
const hideTip = () => (tip.value = null);
const tipStyle = computed(() => {
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
          <span v-if="typedPrice != null" class="muted small">（自訂股價）</span>
          <span v-else-if="price != null" class="muted small">{{ basisLabel }} {{ basisDate }} 收盤 · {{ data.quote?.source || data.priceHistory?.source }}</span>
          <span v-else class="error-inline">抓不到{{ basisLabel }}的股價{{ basis === 'now' && data.quote?.error ? `：${data.quote.error}` : '' }}，請換基準或在右邊輸入</span>
        </div>
        <div class="muted small basis-line">
          所選期末 {{ latest?.priceDate || '—' }} <b>{{ money(latest?.price) }}</b>
          · 申報日 {{ latest?.filingDate || '—' }} <b>{{ money(latest?.priceAtFiling) }}</b>
          · 現在 <b>{{ money(data.quote?.price) }}</b><span v-if="data.quote?.time">（{{ new Date(data.quote.time).toLocaleString() }}）</span>
        </div>
        <div class="muted small">
          市值 {{ big(marketCap) }} · 流通股數 {{ shares(latest?.shares) }}<span v-if="latest?.sharesSource === 'diluted'">（稀釋加權平均）</span><span v-else-if="latest?.periodEnd">（{{ latest.periodEnd }} 申報封面）</span>
          · 近四季至 {{ latest?.periodEnd || '—' }}
          <template v-if="foreign"> · 財報幣別 {{ data.currency.reporting }}，以 {{ data.currency.fxSource }} 匯率 {{ data.currency.fxNow.toFixed(4) }}（各期用當期期末匯率）換算為 {{ data.currency.quote }}</template>
          · 歷史股價 {{ data.priceHistory?.from || '—' }} ～ {{ data.priceHistory?.to || '—' }}<span v-if="data.priceHistory?.splits?.length">，已還原分割（{{ data.priceHistory.splits.map((s) => `${s.date} ${s.ratio}:1`).join('、') }}）</span>
        </div>
      </div>
      <div class="controls">
        <label class="small" title="估值用哪一天的股價：所選申報的期末收盤（與各期表一致）、申報日收盤（看到財報時的價格）、或現在的價格">
          股價基準
          <select v-model="basis">
            <option value="periodEnd">所選期末</option>
            <option value="filingDate">申報日</option>
            <option value="now">現在</option>
          </select>
        </label>
        <label v-if="foreign" class="small" title="一單位 ADR（在美國掛牌的一股）代表幾股普通股；例如台積電 ADR = 5 股普通股。SEC 資料沒有這個比率，請自行填入">
          ADR 比率
          <input v-model="adrInput" type="text" inputmode="decimal" class="price-input short" />
          <span v-if="props.adr === 1" class="error-inline">（請填每 ADR 代表的普通股數，例如 TSM = 5，否則倍數會失真）</span>
        </label>
        <label class="small">
          自訂股價
          <input v-model="priceInput" type="text" inputmode="decimal" placeholder="例如 250" class="price-input" />
        </label>
      </div>
    </div>

    <!-- ===== relative ===== -->
    <h3>相對估值法 <span class="muted small">— {{ basisLabel }}的倍數 vs 過去 {{ data.columns.length }} {{ data.quarterly ? '季' : '年' }}，並用歷史倍數 × 最近四季數字反推股價</span></h3>
    <div class="wrap">
      <table class="summary">
        <thead>
          <tr>
            <th class="name">倍數</th>
            <th class="num">{{ basisLabel }}</th>
            <th class="num">平均</th>
            <th class="num">中位數</th>
            <th class="num">最低</th>
            <th class="num">最高</th>
            <th class="num">合理價（平均）</th>
            <th class="num">合理價（中位數）</th>
            <th class="num">便宜價</th>
            <th class="num">昂貴價</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in data.summary" :key="s.key">
            <td class="name" @mouseenter="showTip(s.name, s.formula, $event)" @mouseleave="hideTip">{{ s.name }}</td>
            <td class="num" :class="cheapness(s, nowMultiples[s.key], s.avg)">{{ mult(s, nowMultiples[s.key]) }}</td>
            <td class="num">{{ mult(s, s.avg) }}</td>
            <td class="num">{{ mult(s, s.median) }}</td>
            <td class="num">{{ mult(s, s.min) }}</td>
            <td class="num">{{ mult(s, s.max) }}</td>
            <td class="num" :class="{ good: upside(fair(s, s.avg)) > 0, bad: upside(fair(s, s.avg)) < 0 }" :title="`相對現價 ${pctOf(upside(fair(s, s.avg)))}`">{{ money(fair(s, s.avg)) }}</td>
            <td class="num" :title="`相對現價 ${pctOf(upside(fair(s, s.median)))}`">{{ money(fair(s, s.median)) }}</td>
            <td class="num">{{ money(fair(s, s.kind === 'yield' ? s.max : s.min)) }}</td>
            <td class="num">{{ money(fair(s, s.kind === 'yield' ? s.min : s.max)) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted small note">「{{ basisLabel }}」欄用 {{ basisLabel }}股價 ${{ money(price) }} 與所選申報的近四季數字；綠色 = 比歷史平均便宜、紅色 = 比歷史平均貴。合理價 = 歷史平均（中位數）倍數 × 每股數字；便宜價 / 昂貴價用歷史最低 / 最高倍數。</p>

    <div ref="wrap" class="wrap">
      <table class="history">
        <thead>
          <tr>
            <th class="name">各期（左舊右新）</th>
            <th v-for="c in data.columns" :key="c.label" class="num" :title="c.periodEnd ? `期末 ${c.periodEnd}，股價為 ${c.priceDate || '—'} 收盤` : ''">
              <div>{{ c.label }}</div>
              <div class="muted end">{{ c.periodEnd }}</div>
            </th>
            <th class="num now">{{ basisLabel }}</th>
          </tr>
        </thead>
        <tbody>
          <tr class="flow">
            <td class="name">股價（期末收盤，未調整分割）</td>
            <td v-for="c in data.columns" :key="c.label" class="num">{{ money(c.price) }}</td>
            <td class="num now">{{ money(price) }}</td>
          </tr>
          <tr class="flow">
            <td class="name">近四季 EPS{{ foreign ? `（每 ADR，${data.currency.quote}）` : '' }}</td>
            <td v-for="c in data.columns" :key="c.label" class="num">{{ money(c.perShareQuote.eps) }}</td>
            <td class="num now">{{ money(nowPs?.eps) }}</td>
          </tr>
          <tr class="flow">
            <td class="name">每股淨值{{ foreign ? `（每 ADR，${data.currency.quote}）` : '' }}</td>
            <td v-for="c in data.columns" :key="c.label" class="num">{{ money(c.perShareQuote.bvps) }}</td>
            <td class="num now">{{ money(nowPs?.bvps) }}</td>
          </tr>
          <tr class="flow">
            <td class="name">每股自由現金流（近四季）</td>
            <td v-for="c in data.columns" :key="c.label" class="num">{{ money(c.perShareQuote.fcfps) }}</td>
            <td class="num now">{{ money(nowPs?.fcfps) }}</td>
          </tr>
          <tr v-for="m in data.multiples" :key="m.key">
            <td class="name" @mouseenter="showTip(m.name, m.formula, $event)" @mouseleave="hideTip">{{ m.name }}</td>
            <td v-for="c in data.columns" :key="c.label" class="num">{{ mult(m, c.multiples[m.key]) }}</td>
            <td class="num now">{{ mult(m, nowMultiples[m.key]) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ===== absolute ===== -->
    <h3>絕對估值法 <span class="muted small">— 以所選申報的近四季數字估算每股內在價值，與{{ basisLabel }}股價比較；假設可以改</span></h3>
    <div class="abs">
      <div class="panel assumptions">
        <div class="muted small head-row">假設 <button class="mini" @click="resetAssumptions">重設為預設</button></div>
        <label>折現率 r <input v-model.number="a.r" type="number" step="0.5" /> %</label>
        <label>前 N 年成長率 g1 <input v-model.number="a.g1" type="number" step="0.5" /> %</label>
        <label>成長年數 N <input v-model.number="a.years" type="number" step="1" min="1" max="20" /> 年</label>
        <label>永續成長率 gT <input v-model.number="a.gT" type="number" step="0.5" /> %</label>
        <label>稅率 <input v-model.number="a.taxRate" type="number" step="1" /> %</label>
        <label>AAA 債殖利率 Y <input v-model.number="a.aaaYield" type="number" step="0.1" /> %</label>
        <label>葛拉漢公式 g <input v-model.number="a.gGraham" type="number" step="0.5" /> %</label>
        <p class="muted small">預設：r 9%、gT 2.5%、N 5 年；g1 取近 {{ data.growth?.years ? f1.format(data.growth.years) : '—' }} 年營收年複合成長率（限 0–15%）；稅率取近四季有效稅率（限 10–30%）。</p>
        <div class="muted small head-row">歷史年複合成長率（{{ data.growth?.years ? f1.format(data.growth.years) : '—' }} 年）</div>
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
                <th class="name">方法</th>
                <th class="num">每股價值</th>
                <th class="num">相對{{ basisLabel }}股價</th>
                <th>說明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in MODELS" :key="m.key">
                <td class="name" @mouseenter="showTip(m.name, m.formula, $event)" @mouseleave="hideTip">{{ m.name }}</td>
                <td class="num" :class="{ good: upside(absolute[m.key]) > 0, bad: upside(absolute[m.key]) < 0 }">{{ money(absolute[m.key]) }}</td>
                <td class="num" :class="{ good: upside(absolute[m.key]) > 0, bad: upside(absolute[m.key]) < 0 }">{{ pctOf(upside(absolute[m.key])) }}</td>
                <td class="desc muted small">{{ m.formula }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="muted small note">相對現價 = 模型價值 ÷ {{ basisLabel }}股價 − 1，正值（綠）代表模型認為被低估。每股價值與股價同幣別{{ foreign ? '（財報數字已依匯率與 ADR 比率換算）' : '' }}；不適用（負 EPS、不配息…）顯示「—」。</p>
        <div class="panel inputs">
          <div class="muted small head-row">模型輸入（近四季至 {{ latest?.periodEnd || '—' }}）</div>
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
  background: #dcfce7;
}
td.bad {
  background: #fee2e2;
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
</style>
