<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from './api';
import CompanySearch from './components/CompanySearch.vue';
import FilingPicker from './components/FilingPicker.vue';
import StatementTable from './components/StatementTable.vue';
import IndicatorsTable from './components/IndicatorsTable.vue';

const company = ref(null);
const filing = ref(null); // the filing row picked from the list
const data = ref(null); // scraped statements JSON
const loadingCompany = ref(false);
const loadingFiling = ref(false);
const error = ref(null);

const tab = ref('balance_sheet');
const divisor = ref(1e6);
const applyNegation = ref(false);
const showConcept = ref(false);
const lang = ref('zh');

// financial indicators page
const indicators = ref(null);
const loadingIndicators = ref(false);
const indicatorsError = ref(null);
const indBasis = ref('x4'); // x4 | ttm
const indMode = ref('quarter'); // quarter | year
const indCountQ = ref(20);
const indCountY = ref(5);
const indCount = computed(() => (indMode.value === 'year' ? indCountY.value : indCountQ.value));
const indAnnualizeAmounts = ref(true);
const indicatorsParams = computed(() => {
  if (!company.value || !filing.value) return null;
  const period = filing.value.quartersYear ? 'Q4' : filing.value.fiscalPeriod;
  return { year: filing.value.fiscalYear, period, n: indCount.value, basis: indBasis.value, mode: indMode.value };
});
const indicatorsEnd = computed(() => {
  const p = indicatorsParams.value;
  if (!p) return '';
  return indicators.value?.quarterly === false ? `FY${p.year}` : `${p.year} ${p.period}`;
});

async function loadIndicators() {
  const p = indicatorsParams.value;
  if (!p) return;
  loadingIndicators.value = true;
  indicatorsError.value = null;
  try {
    indicators.value = await api.indicators(String(company.value.cik), p);
  } catch (e) {
    indicatorsError.value = e.message;
    indicators.value = null;
  } finally {
    loadingIndicators.value = false;
  }
}

watch([tab, indicatorsParams], ([t, p], [, prev]) => {
  if (t !== 'indicators' || !p) return;
  if (indicators.value && JSON.stringify(p) === JSON.stringify(prev) && !indicatorsError.value) return;
  loadIndicators();
});

const TABS = [
  ['balance_sheet', '資產負債表'],
  ['income_statement', '損益表'],
  ['cash_flow', '現金流量表'],
  ['equity', '股東權益變動表'],
];
const isIndicators = computed(() => tab.value === 'indicators');

const otherStatements = computed(() => {
  if (!data.value) return [];
  const primary = new Set(Object.values(data.value.statements).filter(Boolean).map((s) => s.role));
  return data.value.allStatements.filter((s) => !primary.has(s.role));
});

const current = computed(() => {
  if (!data.value) return null;
  if (tab.value.startsWith('role:')) return otherStatements.value.find((s) => s.role === tab.value.slice(5)) || null;
  return data.value.statements[tab.value];
});

async function loadCompany(id, accession = null, quartersYear = null) {
  error.value = null;
  loadingCompany.value = true;
  data.value = null;
  filing.value = null;
  try {
    company.value = await api.company(id);
    if (quartersYear) return await loadQuarters(quartersYear);
    const pick = (accession && company.value.filings.find((f) => f.accession === accession)) || company.value.filings[0];
    if (pick) await loadFiling(pick);
  } catch (e) {
    error.value = e.message;
    company.value = null;
  } finally {
    loadingCompany.value = false;
  }
}

async function loadFiling(f) {
  error.value = null;
  loadingFiling.value = true;
  filing.value = f;
  try {
    data.value = await api.filing(f.cik, f.accession);
    const valid = tab.value.startsWith('role:')
      ? data.value.allStatements.some((s) => `role:${s.role}` === tab.value)
      : tab.value === 'indicators' || !!data.value.statements[tab.value];
    if (!valid) tab.value = 'balance_sheet';
  } catch (e) {
    error.value = e.message;
    data.value = null;
  } finally {
    loadingFiling.value = false;
  }
}

// Q4 derived view: Q1-Q3 from the 10-Qs, FY from the 10-K, Q4 = FY - Q1 - Q2 - Q3.
async function loadQuarters(year) {
  error.value = null;
  loadingFiling.value = true;
  filing.value = { accession: `q4-${year}`, form: 'Q4 推算', fiscalYear: year, fiscalPeriod: 'Q4', quartersYear: year };
  try {
    data.value = await api.quarters(String(company.value.cik), year);
    if (!data.value.statements[tab.value] && !tab.value.startsWith('role:') && tab.value !== 'indicators') tab.value = 'income_statement';
    if (tab.value.startsWith('role:') && !data.value.allStatements.some((s) => `role:${s.role}` === tab.value)) tab.value = 'income_statement';
  } catch (e) {
    error.value = e.message;
    data.value = null;
  } finally {
    loadingFiling.value = false;
  }
}

const jsonUrl = computed(() => {
  if (!data.value) return '#';
  if (data.value.derived) return api.quartersUrl(String(data.value.filing.cik), data.value.filing.fiscalYear);
  return api.filingUrl(data.value.filing.cik, data.value.filing.accession);
});

// Keep the selection in the URL so a view can be bookmarked / shared.
watch([company, filing, tab, indMode], () => {
  const p = new URLSearchParams();
  if (company.value) p.set('company', company.value.tickers[0] || String(company.value.cik));
  if (filing.value?.quartersYear) p.set('quarters', filing.value.quartersYear);
  else if (filing.value) p.set('accession', filing.value.accession);
  if (data.value && tab.value !== 'balance_sheet') p.set('tab', tab.value);
  if (tab.value === 'indicators' && indMode.value === 'year') p.set('mode', 'year');
  history.replaceState(null, '', p.size ? `?${p}` : location.pathname);
});

onMounted(() => {
  const p = new URLSearchParams(location.search);
  if (p.get('tab')) tab.value = p.get('tab');
  if (p.get('mode') === 'year') indMode.value = 'year';
  if (p.get('company')) loadCompany(p.get('company'), p.get('accession'), p.get('quarters') ? Number(p.get('quarters')) : null);
});
</script>

<template>
  <div class="app">
    <header>
      <h1>stockscan <span class="muted">SEC Inline XBRL 財報瀏覽</span></h1>
      <CompanySearch @select="loadCompany" />
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="loadingCompany" class="muted">讀取公司資料…</p>

    <div v-if="company" class="layout">
      <aside class="panel">
        <h2>{{ company.name }}</h2>
        <div class="muted small">
          {{ company.tickers.join(', ') }} · CIK {{ company.cik }}
          <span v-if="company.fiscalYearEnd"> · 會計年度結束 {{ company.fiscalYearEnd.slice(0, 2) }}/{{ company.fiscalYearEnd.slice(2) }}</span>
          <div v-if="company.sicDescription">{{ company.sicDescription }}</div>
        </div>
        <h3>選擇年度 / 季度</h3>
        <FilingPicker :filings="company.filings" :selected="filing?.accession" @select="loadFiling" @select-quarters="loadQuarters" />
        <p class="muted small">FY = 年報 (10-K / 20-F / 40-F)，Q1–Q3 = 季報 (10-Q)。Q4 數字請看年報。</p>
      </aside>

      <main>
        <p v-if="loadingFiling" class="muted">下載並解析 {{ filing?.form }} {{ filing?.fiscalYear }} {{ filing?.fiscalPeriod }}…</p>

        <template v-if="data && !loadingFiling">
          <div class="panel meta">
            <div v-if="data.derived">
              <strong>FY{{ data.filing.fiscalYear }} 各季推算</strong>
              · Q4 = FY − Q1 − Q2 − Q3 · 來源：
              <template v-for="(src, p, i) in data.sources" :key="p">
                <span v-if="i">、</span>
                <a :href="src.viewerUrl" target="_blank" rel="noopener">{{ p }} {{ src.form }}</a>
              </template>
            </div>
            <div v-else>
              <strong>{{ data.filing.form }}</strong>
              {{ data.filing.fiscalPeriod === 'FY' ? `FY${data.filing.fiscalYear}` : `FY${data.filing.fiscalYear} ${data.filing.fiscalPeriod}` }} · 期末 {{ data.filing.periodEnd }} · 申報日 {{ data.filing.filingDate }}
            </div>
            <div class="links">
              <a v-if="!data.derived" :href="data.filing.viewerUrl" target="_blank" rel="noopener">SEC 原始 Inline XBRL</a>
              <a :href="jsonUrl" target="_blank" rel="noopener">JSON</a>
              <span class="muted small">{{ data.stats.facts }} facts<template v-if="data.stats.contexts"> · {{ data.stats.contexts }} contexts</template></span>
            </div>
          </div>
          <p v-if="data.derived" class="muted small note">
            損益表 / 現金流量表：Q1–Q3 取自 10-Q（三個月欄或年初至今欄相減），Q4 = 10-K 全年 − 前三季。每股金額以相減近似（以 ≈ 標示）；股數等不可相減的項目 Q4 留空。資產負債表為各季期末餘額。股東權益變動表不提供推算。
          </p>

          <div class="toolbar">
            <div class="tabs">
              <button v-for="[key, name] in TABS" :key="key" :class="{ active: tab === key }" :disabled="!data.statements[key]" @click="tab = key">
                {{ name }}
              </button>
              <button :class="{ active: tab === 'indicators' }" @click="tab = 'indicators'">財務指標</button>
              <select v-if="otherStatements.length" :value="tab.startsWith('role:') ? tab : ''" @change="tab = $event.target.value">
                <option value="" disabled>其他報表…</option>
                <option v-for="s in otherStatements" :key="s.role" :value="`role:${s.role}`">{{ s.title }}</option>
              </select>
            </div>
            <div v-if="isIndicators" class="options">
              <label v-if="indicators?.quarterly !== false">
                檢視
                <select v-model="indMode">
                  <option value="quarter">逐季</option>
                  <option value="year">逐年（近四季合計）</option>
                </select>
              </label>
              <label v-if="indMode === 'year' || indicators?.quarterly === false">
                年數
                <select v-model.number="indCountY">
                  <option :value="3">3</option>
                  <option :value="5">5</option>
                  <option :value="8">8</option>
                  <option :value="10">10</option>
                </select>
              </label>
              <label v-else>
                季數
                <select v-model.number="indCountQ">
                  <option :value="8">8</option>
                  <option :value="12">12</option>
                  <option :value="20">20</option>
                  <option :value="40">40</option>
                </select>
              </label>
              <template v-if="indMode === 'quarter' && indicators?.quarterly !== false">
                <label>
                  年化
                  <select v-model="indBasis">
                    <option value="x4">單季 ×4</option>
                    <option value="ttm">近四季合計</option>
                  </select>
                </label>
                <label><input v-model="indAnnualizeAmounts" type="checkbox" /> 金額列也年化</label>
              </template>
            </div>
            <div v-else class="options">
              <label>
                科目
                <select v-model="lang">
                  <option value="zh">中文</option>
                  <option value="en">英文</option>
                </select>
              </label>
              <label>
                單位
                <select v-model.number="divisor">
                  <option :value="1">原始</option>
                  <option :value="1e3">千</option>
                  <option :value="1e6">百萬</option>
                  <option :value="1e9">十億</option>
                </select>
              </label>
              <label><input v-model="applyNegation" type="checkbox" /> 依報表顯示反號</label>
              <label><input v-model="showConcept" type="checkbox" /> 顯示 XBRL 概念名稱</label>
            </div>
          </div>

          <template v-if="isIndicators">
            <p v-if="loadingIndicators" class="muted">計算到 {{ indicatorsEnd }} 為止的 {{ indCount }} {{ indMode === 'year' ? '年' : '期' }}指標，需下載多份申報，第一次約 20–40 秒…</p>
            <p v-else-if="indicatorsError" class="error">{{ indicatorsError }}</p>
            <template v-else-if="indicators">
              <p v-if="indicators.quarterly && indicators.mode === 'year'" class="muted small note">
                以所選申報（{{ indicatorsEnd }}）為最後一期，每一欄 = 到該季為止連續四季的合計（例如 {{ indicators.columns.at(-1)?.sublabel || indicators.columns.at(-1)?.label }}），往前共 {{ indicators.columns.length }} 年，左舊右新。
                餘額取該季季末，平均餘額用季末與四季前季末平均。Q4 流量 = 10-K 全年 − 前三季。
                <a :href="api.indicatorsUrl(String(company.cik), indicatorsParams)" target="_blank" rel="noopener">JSON</a>
              </p>
              <p v-else-if="indicators.quarterly" class="muted small note">
                以所選申報（{{ indicatorsEnd }}）為最後一期，往前共 {{ indicators.columns.length }} 季，左舊右新。
                週轉率、ROA、ROE、現金流量比率等使用流量的指標，分子皆換算為年（{{ indBasis === 'ttm' ? '近四季合計' : '單季 ×4' }}），分母用本季末與上季末平均。
                Q4 流量 = 10-K 全年 − 前三季。
                <a :href="api.indicatorsUrl(String(company.cik), indicatorsParams)" target="_blank" rel="noopener">JSON</a>
              </p>
              <p v-else class="muted small note">
                年報公司：每一欄為一個會計年度，往前共 {{ indicators.columns.length }} 年，左舊右新。
                <a :href="api.indicatorsUrl(String(company.cik), indicatorsParams)" target="_blank" rel="noopener">JSON</a>
              </p>
              <IndicatorsTable :data="indicators" :annualize-amounts="indAnnualizeAmounts" />
            </template>
          </template>
          <template v-else>
            <StatementTable v-if="current" :statement="current" :divisor="divisor" :apply-negation="applyNegation" :show-concept="showConcept" :lang="lang" />
            <p v-else class="muted">這份申報沒有這張報表。</p>
          </template>
        </template>
      </main>
    </div>

    <div v-else-if="!loadingCompany" class="empty muted">
      輸入股票代號開始，例如 <a href="?company=GOOGL" @click.prevent="loadCompany('GOOGL')">GOOGL</a>、
      <a href="?company=AAPL" @click.prevent="loadCompany('AAPL')">AAPL</a>、
      <a href="?company=TSM" @click.prevent="loadCompany('TSM')">TSM</a>
    </div>
  </div>
</template>

<style scoped>
.app {
  max-width: 1600px;
  margin: 0 auto;
  padding: 16px 20px 40px;
}
header {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 24px;
  align-items: center;
  margin-bottom: 16px;
}
h1 {
  font-size: 20px;
  margin: 0;
  white-space: nowrap;
}
h1 .muted {
  font-weight: normal;
  font-size: 14px;
  margin-left: 8px;
}
h2 {
  font-size: 16px;
  margin: 0 0 4px;
}
h3 {
  font-size: 13px;
  margin: 16px 0 8px;
  color: var(--muted);
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
.layout {
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 16px;
  align-items: start;
}
aside {
  position: sticky;
  top: 16px;
}
main {
  min-width: 0; /* let the statement table scroll inside instead of widening the page */
}
.meta {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 16px;
  margin-bottom: 12px;
}
.links {
  display: flex;
  gap: 16px;
  align-items: center;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.options {
  display: flex;
  gap: 16px;
  align-items: center;
  font-size: 13px;
}
select {
  font: inherit;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}
.note {
  margin: -4px 0 12px;
}
.empty {
  text-align: center;
  padding: 80px 0;
}
@media (max-width: 900px) {
  header,
  .layout {
    grid-template-columns: 1fr;
  }
  aside {
    position: static;
  }
}
</style>
