<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from './api';
import CompanySearch from './components/CompanySearch.vue';
import FilingPicker from './components/FilingPicker.vue';
import StatementTable from './components/StatementTable.vue';

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

const TABS = [
  ['balance_sheet', '資產負債表'],
  ['income_statement', '損益表'],
  ['cash_flow', '現金流量表'],
  ['equity', '股東權益變動表'],
];

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
      : !!data.value.statements[tab.value];
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
    if (!data.value.statements[tab.value] && !tab.value.startsWith('role:')) tab.value = 'income_statement';
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
watch([company, filing, tab], () => {
  const p = new URLSearchParams();
  if (company.value) p.set('company', company.value.tickers[0] || String(company.value.cik));
  if (filing.value?.quartersYear) p.set('quarters', filing.value.quartersYear);
  else if (filing.value) p.set('accession', filing.value.accession);
  if (data.value && tab.value !== 'balance_sheet') p.set('tab', tab.value);
  history.replaceState(null, '', p.size ? `?${p}` : location.pathname);
});

onMounted(() => {
  const p = new URLSearchParams(location.search);
  if (p.get('tab')) tab.value = p.get('tab');
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
              <select v-if="otherStatements.length" :value="tab.startsWith('role:') ? tab : ''" @change="tab = $event.target.value">
                <option value="" disabled>其他報表…</option>
                <option v-for="s in otherStatements" :key="s.role" :value="`role:${s.role}`">{{ s.title }}</option>
              </select>
            </div>
            <div class="options">
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

          <StatementTable v-if="current" :statement="current" :divisor="divisor" :apply-negation="applyNegation" :show-concept="showConcept" :lang="lang" />
          <p v-else class="muted">這份申報沒有這張報表。</p>
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
