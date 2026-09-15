<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from './api';
import CompanySearch from './components/CompanySearch.vue';
import FilingPicker from './components/FilingPicker.vue';
import StatementTable from './components/StatementTable.vue';
import IndicatorsTable from './components/IndicatorsTable.vue';
import ValuationPanel from './components/ValuationPanel.vue';
import BrowsePage from './components/BrowsePage.vue';
import WatchlistPage from './components/WatchlistPage.vue';
import ScreenerPage from './components/ScreenerPage.vue';
import ScoreCard from './components/ScoreCard.vue';
import { isWatched, toggleWatch, watchlist } from './watchlist';

// background crawl progress (server-side), shown in the header
const status = ref(null);
async function pollStatus() {
  try {
    status.value = await api.status();
  } catch {
    status.value = null;
  }
}
const crawlText = computed(() => {
  const c = status.value?.crawler;
  if (!c?.enabled) return '';
  const saved = status.value.store.filings.toLocaleString();
  if (c.phase === 'sweep') return `背景下載最新財報 ${c.position.toLocaleString()} / ${c.total.toLocaleString()}${c.current ? ` · ${c.current}` : ''} · 已存 ${saved} 份`;
  if (c.phase === 'watch') return `已存 ${saved} 份財報 · 監看 EDGAR 新申報${c.lastWatch ? `（${new Date(c.lastWatch).toLocaleTimeString()}）` : ''}`;
  return '';
});

// page: 'report' (statements of one company) | 'browse' (industry / filer status / ETF lists) | 'watch' (watchlist)
const page = ref('report');
const browseParams = ref({});

const company = ref(null);
const filing = ref(null); // the filing row picked from the list
const data = ref(null); // scraped statements JSON
const loadingCompany = ref(false);
const refreshing = ref(false);
const refreshMessage = ref('');

// Re-read the filing list from SEC (bypassing the 10-minute cache) - for the
// day a new 10-Q / 10-K comes out.
async function refreshFilings() {
  if (!company.value || refreshing.value) return;
  refreshing.value = true;
  refreshMessage.value = '';
  try {
    const before = new Set(company.value.filings.map((f) => f.accession));
    const fresh = await api.company(String(company.value.cik), { refresh: true });
    const added = fresh.filings.filter((f) => !before.has(f.accession));
    company.value = fresh;
    refreshMessage.value = added.length
      ? `新增 ${added.length} 份：${added.map((f) => `${f.form} ${f.fiscalYear} ${f.fiscalPeriod}`).join('、')}`
      : `沒有新申報（SEC 清單 ${new Date(fresh.filingsUpdatedAt).toLocaleTimeString()}）`;
    if (added.length && !filing.value?.quartersYear) await loadFiling(added[0]);
  } catch (e) {
    refreshMessage.value = `更新失敗：${e.message}`;
  } finally {
    refreshing.value = false;
  }
}
const loadingFiling = ref(false);
const error = ref(null);

const tab = ref('balance_sheet');
const divisor = ref(1e6);
const applyNegation = ref(false);
const showConcept = ref(false);
const lang = ref('zh');
const view = ref('current'); // current = only the filing's own period | all = every column in the filing

// financial indicators page
const indicators = ref(null);
const loadingIndicators = ref(false);
const indicatorsError = ref(null);
const indBasis = ref('x4'); // x4 | ttm
const indMode = ref('quarter'); // quarter | year
const indCountQ = ref(20);
const indCountY = ref(5);
const indCount = computed(() => (indMode.value === 'quarter' ? indCountQ.value : indCountY.value));
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

// valuation page (relative multiples over N quarters + absolute models)
const valuation = ref(null);
const loadingValuation = ref(false);
const valuationError = ref(null);
const valCount = ref(20);
const valAdr = ref(1); // ADR ratio for foreign filers (ordinary shares per listed share)
const valuationParams = computed(() => {
  if (!company.value || !filing.value) return null;
  const period = filing.value.quartersYear ? 'Q4' : filing.value.fiscalPeriod;
  return { year: filing.value.fiscalYear, period, n: valCount.value, ...(valAdr.value !== 1 ? { adr: valAdr.value } : {}) };
});
watch(company, () => (valAdr.value = 1));
async function loadValuation() {
  const p = valuationParams.value;
  if (!p) return;
  loadingValuation.value = true;
  valuationError.value = null;
  try {
    valuation.value = await api.valuation(String(company.value.cik), p);
  } catch (e) {
    valuationError.value = e.message;
    valuation.value = null;
  } finally {
    loadingValuation.value = false;
  }
}
watch([tab, valuationParams], ([t, p], [, prev]) => {
  if (t !== 'valuation' || !p) return;
  if (valuation.value && JSON.stringify(p) === JSON.stringify(prev) && !valuationError.value) return;
  loadValuation();
});
const isValuation = computed(() => tab.value === 'valuation');

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

// score of the selected filing, shown on the indicators tab
const filingScore = ref(null);
watch(
  [tab, filing],
  async ([t, f]) => {
    if (t !== 'indicators' || !f || f.quartersYear) {
      if (f?.quartersYear) filingScore.value = null;
      return;
    }
    if (filingScore.value?.accession === f.accession) return;
    filingScore.value = null;
    try {
      filingScore.value = await api.score(f.cik, f.accession);
    } catch {
      filingScore.value = null;
    }
  },
  { immediate: true },
);

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

function openBrowse(params) {
  browseParams.value = { cat: 'sic', code: '', afs: '', etf: '', ...params };
  page.value = 'browse';
}
const fmtFloat = (v) => (v >= 1e12 ? `${(v / 1e12).toFixed(2)} 兆美元` : v >= 1e8 ? `${Math.round(v / 1e8).toLocaleString()} 億美元` : `${Math.round(v / 1e6).toLocaleString()} 百萬美元`);

// From the search box or a browse list: show the statements page for that company.
function openCompany(idOrRow) {
  const id = typeof idOrRow === 'string' ? idOrRow : idOrRow.ticker || String(idOrRow.cik);
  page.value = 'report';
  loadCompany(id);
}

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
    data.value = await api.filing(f.cik, f.accession, view.value);
    const valid = tab.value.startsWith('role:')
      ? data.value.allStatements.some((s) => `role:${s.role}` === tab.value)
      : tab.value === 'indicators' || tab.value === 'valuation' || !!data.value.statements[tab.value];
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
    if (!data.value.statements[tab.value] && !tab.value.startsWith('role:') && tab.value !== 'indicators' && tab.value !== 'valuation') tab.value = 'income_statement';
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
  return api.filingUrl(data.value.filing.cik, data.value.filing.accession, view.value);
});

// switching 本期 / 全部 reloads the same filing (fast: both are served from cache)
watch(view, () => {
  if (filing.value && !filing.value.quartersYear) loadFiling(filing.value);
});

// Keep the selection in the URL so a view can be bookmarked / shared. Switching
// between 財報 and 分類瀏覽 pushes a history entry so the browser's Back
// button returns to the list you came from.
let lastPage = page.value;
let restoring = false;
watch([company, filing, tab, indMode, view, page, browseParams], () => {
  const p = new URLSearchParams();
  if (page.value === 'browse') {
    p.set('page', 'browse');
    for (const [k, v] of Object.entries(browseParams.value)) if (v) p.set(k, v);
  } else if (page.value === 'watch' || page.value === 'screen') {
    p.set('page', page.value);
  } else {
    if (company.value) p.set('company', company.value.tickers[0] || String(company.value.cik));
    if (filing.value?.quartersYear) p.set('quarters', filing.value.quartersYear);
    else if (filing.value) p.set('accession', filing.value.accession);
    if (data.value && tab.value !== 'balance_sheet') p.set('tab', tab.value);
    if (tab.value === 'indicators' && indMode.value !== 'quarter') p.set('mode', indMode.value);
    if (view.value === 'all') p.set('view', 'all');
  }
  const url = p.size ? `?${p}` : location.pathname;
  if (page.value !== lastPage && !restoring) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  lastPage = page.value;
});

function applyUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get('tab')) tab.value = p.get('tab');
  if (['year', 'same'].includes(p.get('mode'))) indMode.value = p.get('mode');
  if (p.get('view') === 'all') view.value = 'all';
  if (p.get('page') === 'browse') {
    page.value = 'browse';
    browseParams.value = { cat: p.get('cat') || 'sic', code: p.get('code') || '', afs: p.get('afs') || '', etf: p.get('etf') || '' };
    return;
  }
  if (p.get('page') === 'watch' || p.get('page') === 'screen') {
    page.value = p.get('page');
    return;
  }
  page.value = 'report';
  const id = p.get('company');
  if (id && (!company.value || (!company.value.tickers.includes(id.toUpperCase()) && String(company.value.cik) !== id))) {
    loadCompany(id, p.get('accession'), p.get('quarters') ? Number(p.get('quarters')) : null);
  }
}

onMounted(() => {
  pollStatus();
  setInterval(pollStatus, 15_000);
  applyUrl();
  window.addEventListener('popstate', () => {
    restoring = true;
    applyUrl();
    setTimeout(() => (restoring = false), 0);
  });
});
</script>

<template>
  <div class="app">
    <header>
      <h1>stockscan <span class="muted">SEC Inline XBRL 財報瀏覽</span></h1>
      <nav class="nav">
        <button :class="{ active: page === 'report' }" @click="page = 'report'">財報</button>
        <button :class="{ active: page === 'browse' }" @click="page = 'browse'">分類瀏覽</button>
        <button :class="{ active: page === 'screen' }" @click="page = 'screen'">尋找股票</button>
        <button :class="{ active: page === 'watch' }" @click="page = 'watch'">觀察名單<span v-if="watchlist.items.length" class="count">{{ watchlist.items.length }}</span></button>
      </nav>
      <CompanySearch @select="openCompany" />
    </header>
    <p v-if="crawlText" class="muted small crawl" title="啟動後在背景把每家有代號的公司最新一份 10-K / 10-Q 存到本機，之後點開就不用等下載；使用中會自動讓路">{{ crawlText }}</p>

    <BrowsePage v-if="page === 'browse'" :params="browseParams" @open="openCompany" @navigate="browseParams = $event" />
    <WatchlistPage v-else-if="page === 'watch'" @open="openCompany" />
    <ScreenerPage v-else-if="page === 'screen'" @open="openCompany" />

    <template v-else>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="loadingCompany" class="muted">讀取公司資料…</p>

    <div v-if="company" class="layout">
      <aside class="panel">
        <h2>
          <button class="star" :class="{ on: isWatched(company.cik) }" :title="isWatched(company.cik) ? '從觀察名單移除' : '加入觀察名單'" @click="toggleWatch(company)">{{ isWatched(company.cik) ? '★' : '☆' }}</button>
          {{ company.name }}
        </h2>
        <div class="muted small">
          {{ company.tickers.join(', ') }} · CIK {{ company.cik }}
          <span v-if="company.fiscalYearEnd"> · 會計年度結束 {{ company.fiscalYearEnd.slice(0, 2) }}/{{ company.fiscalYearEnd.slice(2) }}</span>
          <div v-if="company.sic">
            <a :href="`?page=browse&cat=sic&code=${company.sic}`" title="看同產業的公司" @click.prevent="openBrowse({ cat: 'sic', code: String(company.sic) })">
              SIC {{ company.sic }} {{ company.sicZh || company.sicDescription }}
            </a>
          </div>
          <div v-if="company.filer?.filerStatus">
            <a :href="`?page=browse&cat=filer&afs=${company.filer.afs}`" title="看同一申報身分的公司" @click.prevent="openBrowse({ cat: 'filer', afs: company.filer.afs })">{{ company.filer.filerStatus.zh }}</a><span v-if="company.filer.wksi"> · WKSI</span>
            <span v-if="company.filer.publicFloat != null"> · 公眾流通市值 {{ fmtFloat(company.filer.publicFloat) }}<span v-if="company.filer.publicFloatAdjusted" title="申報值疑似單位錯誤，已除以 1,000">*</span>（{{ company.filer.publicFloatDate }}）</span>
          </div>
        </div>
        <h3>
          選擇年度 / 季度
          <button class="refresh" :disabled="refreshing" title="重新向 SEC 讀取申報清單，今天剛發布的 10-Q / 10-K 會出現在這裡" @click="refreshFilings">
            {{ refreshing ? '更新中…' : '↻ 更新' }}
          </button>
        </h3>
        <p v-if="refreshMessage" class="small refresh-msg">{{ refreshMessage }}</p>
        <FilingPicker :filings="company.filings" :selected="filing?.accession" @select="loadFiling" @select-quarters="loadQuarters" />
        <p class="muted small">FY = 年報 (10-K / 20-F / 40-F)，Q1–Q3 = 季報 (10-Q)。Q4 數字請看年報。</p>
        <p class="muted small">清單讀取時間 {{ new Date(company.filingsUpdatedAt).toLocaleString() }}<span v-if="company.filingsStale">（SEC 連不上，顯示舊清單）</span></p>
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
          <p v-if="data.view === 'current' && !isIndicators && !isValuation" class="muted small note">
            只看本期：資產負債表 = 本期末；損益表 = {{ data.filing.form?.startsWith('10-Q') ? '本季三個月' : '全年度' }}；現金流量表、權益變動表一欄到底 —— 「（期初）」列是期初餘額、「（期末）」列是期末餘額、其餘列是本期發生數。
            <template v-if="data.previous">10-Q 的現金流量表只有年初至今，本季 = 年初至今 − 上一季（{{ data.previous.fiscalYear }} {{ data.previous.fiscalPeriod }}）年初至今，期初餘額 = 上一季期末，這些欄標「推算」。</template>
            <template v-for="n in data.notes.filter((x) => /找不到/.test(x))" :key="n"> {{ n }}</template>
            比較欄位請切換「欄位 → 申報書全部欄位」。
          </p>
          <p v-if="data.derived" class="muted small note">
            損益表 / 現金流量表：Q1–Q3 取自 10-Q（三個月欄或年初至今欄相減），Q4 = 10-K 全年 − 前三季。每股金額以相減近似（以 ≈ 標示）；股數等不可相減的項目 Q4 留空。資產負債表為各季期末餘額。股東權益變動表不提供推算。
          </p>

          <div class="toolbar">
            <div class="tabs">
              <button v-for="[key, name] in TABS" :key="key" :class="{ active: tab === key }" :disabled="!data.statements[key]" @click="tab = key">
                {{ name }}
              </button>
              <button :class="{ active: tab === 'indicators' }" @click="tab = 'indicators'">財務指標</button>
              <button :class="{ active: tab === 'valuation' }" @click="tab = 'valuation'">股價估值</button>
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
                  <option value="same">同季比較（歷年同一季）</option>
                </select>
              </label>
              <label v-if="indMode !== 'quarter' || indicators?.quarterly === false">
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
              <template v-if="indMode !== 'year' && indicators?.quarterly !== false">
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
            <div v-else-if="isValuation" class="options">
              <label>
                {{ valuation?.quarterly === false ? '年數' : '季數' }}
                <select v-model.number="valCount">
                  <option :value="8">8</option>
                  <option :value="12">12</option>
                  <option :value="20">20</option>
                  <option :value="40">40</option>
                </select>
              </label>
              <a v-if="valuationParams" :href="api.valuationUrl(String(company.cik), valuationParams)" target="_blank" rel="noopener" class="small">JSON</a>
            </div>
            <div v-else class="options">
              <label v-if="!data.derived">
                欄位
                <select v-model="view">
                  <option value="current">只看本期</option>
                  <option value="all">申報書全部欄位</option>
                </select>
              </label>
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
            <ScoreCard v-if="filingScore && !filing?.quartersYear" :score="filingScore" />
            <p v-if="loadingIndicators" class="muted">計算到 {{ indicatorsEnd }} 為止的 {{ indCount }} {{ indMode === 'quarter' ? '期' : '年' }}指標，需下載多份申報，第一次約 20–40 秒…</p>
            <p v-else-if="indicatorsError" class="error">{{ indicatorsError }}</p>
            <template v-else-if="indicators">
              <p v-if="indicators.quarterly && indicators.mode === 'year'" class="muted small note">
                以所選申報（{{ indicatorsEnd }}）為最後一期，每一欄 = 到該季為止連續四季的合計（例如 {{ indicators.columns.at(-1)?.sublabel || indicators.columns.at(-1)?.label }}），往前共 {{ indicators.columns.length }} 年，左舊右新。
                餘額取該季季末，平均餘額用季末與四季前季末平均。Q4 流量 = 10-K 全年 − 前三季。
                <a :href="api.indicatorsUrl(String(company.cik), indicatorsParams)" target="_blank" rel="noopener">JSON</a>
              </p>
              <p v-else-if="indicators.quarterly && indicators.mode === 'same'" class="muted small note">
                只看所選季度（{{ indicatorsParams.period }}）：{{ indicators.columns[0]?.label }} ～ {{ indicators.columns.at(-1)?.label }} 共 {{ indicators.columns.length }} 年同一季的單季數字，左舊右新，避開季節性直接比年增。
                流量類指標分子換算為年（{{ indBasis === 'ttm' ? '近四季合計' : '單季 ×4' }}），分母用該季末與上季末平均。Q4 流量 = 10-K 全年 − 前三季。
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
          <template v-else-if="isValuation">
            <p v-if="loadingValuation" class="muted">計算到 {{ valuationParams?.year }} {{ valuationParams?.period }} 為止 {{ valCount }} 期的估值，需下載多份申報與股價，第一次約 20–40 秒…</p>
            <p v-else-if="valuationError" class="error">{{ valuationError }}</p>
            <ValuationPanel v-else-if="valuation" :data="valuation" :adr="valAdr" @update:adr="valAdr = $event" />
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
      <a href="?company=TSM" @click.prevent="loadCompany('TSM')">TSM</a>，
      或到 <a href="?page=browse" @click.prevent="page = 'browse'">分類瀏覽</a> 依產業、申報身分、ETF 成分股找公司，
      或用 <a href="?page=screen" @click.prevent="page = 'screen'">尋找股票</a> 依最新財報的指標篩選。
    </div>
    </template>
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
  grid-template-columns: auto auto 1fr;
  gap: 24px;
  align-items: center;
  margin-bottom: 16px;
}
.nav {
  display: flex;
  gap: 6px;
}
.nav .count {
  margin-left: 5px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.35);
  border-radius: 8px;
  padding: 0 5px;
}
.nav button:not(.active) .count {
  background: var(--accent-soft);
  color: var(--accent);
}
.star {
  border: none;
  background: none;
  padding: 0 4px 0 0;
  font-size: 18px;
  color: var(--muted);
  cursor: pointer;
  vertical-align: -1px;
}
.star.on {
  color: #f59e0b;
}
.crawl {
  margin: -8px 0 12px;
  text-align: right;
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
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.refresh {
  font-size: 12px;
  padding: 3px 8px;
}
.refresh-msg {
  color: var(--accent);
  margin: 0 0 8px;
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
