<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { createBasket } from '../baskets';
import CompanyTable from './CompanyTable.vue';
import ScoreBadge from './ScoreBadge.vue';
import { isWatched, toggleWatch } from '../watchlist';

// params: { cat: 'sic'|'filer'|'etf', code, afs, etf }
const props = defineProps({ params: { type: Object, default: () => ({}) } });
const emit = defineEmits(['open', 'navigate', 'basket']);

const cat = ref(props.params.cat || 'sic');
const code = ref(props.params.code || '');
const afs = ref(props.params.afs || '');
const etf = ref(props.params.etf || '');
const listedOnly = ref(true);
const filter = ref('');
const error = ref(null);

watch([cat, code, afs, etf], () => {
  emit('navigate', { cat: cat.value, code: cat.value === 'sic' ? code.value : '', afs: cat.value === 'filer' ? afs.value : '', etf: cat.value === 'etf' ? etf.value : '' });
});
// browser Back / Forward: the parent hands the URL state back down
watch(
  () => props.params,
  (p) => {
    if (p.cat && p.cat !== cat.value) cat.value = p.cat;
    if (p.cat === 'sic' && (p.code || '') !== code.value) code.value = p.code || '';
    if (p.cat === 'filer' && (p.afs || '') !== afs.value) afs.value = p.afs || '';
    if (p.cat === 'etf' && (p.etf || '') !== etf.value) etf.value = p.etf || '';
  },
  { deep: true },
);

// ---------- SIC ----------
const sic = ref(null);
const sicFilter = ref('');
const openDivisions = ref(new Set());

const sicGroups = computed(() => {
  if (!sic.value) return [];
  const q = sicFilter.value.trim().toUpperCase();
  return sic.value.divisions
    .map((d) => {
      const codes = sic.value.codes
        .filter((c) => c.division === d.id && (listedOnly.value ? c.listed : c.total))
        .filter((c) => !q || c.code.startsWith(q) || (c.zh || '').toUpperCase().includes(q) || (c.title || '').toUpperCase().includes(q))
        .sort((a, b) => a.code.localeCompare(b.code));
      return { ...d, codes, listed: codes.reduce((s, c) => s + c.listed, 0), total: codes.reduce((s, c) => s + c.total, 0) };
    })
    .filter((d) => d.codes.length);
});
const selectedSic = computed(() => sic.value?.codes.find((c) => c.code === code.value) || null);

function toggleDivision(id) {
  const s = new Set(openDivisions.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  openDivisions.value = s;
}

// ---------- filer status ----------
const filer = ref(null);

// ---------- company list (SIC / filer) ----------
const companies = ref(null);
const loadingCompanies = ref(false);
const companiesKey = computed(() => (cat.value === 'sic' && code.value ? `sic=${code.value}` : cat.value === 'filer' && afs.value ? `afs=${afs.value}` : ''));

async function loadCompanies() {
  if (!companiesKey.value) {
    companies.value = null;
    return;
  }
  loadingCompanies.value = true;
  error.value = null;
  try {
    const params = cat.value === 'sic' ? { sic: code.value } : { afs: afs.value };
    companies.value = await api.browseCompanies({ ...params, listed: listedOnly.value ? '1' : '0', limit: 5000 });
  } catch (e) {
    error.value = e.message;
    companies.value = null;
  } finally {
    loadingCompanies.value = false;
  }
}
watch([companiesKey, listedOnly], loadCompanies);

// latest-filing scores for whatever is on screen (batched; server reads them from SQLite)
const scores = ref({});
async function loadScores(ciks) {
  const need = [...new Set(ciks.filter((c) => c && !(c in scores.value)))];
  for (let i = 0; i < need.length; i += 1500) {
    try {
      const r = await api.scores(need.slice(i, i + 1500));
      scores.value = { ...scores.value, ...r.scores };
    } catch {
      /* scores are decoration: ignore failures */
    }
  }
}
watch(companies, (c) => c && loadScores(c.companies.map((x) => x.cik)));

const visibleCompanies = computed(() => {
  if (!companies.value) return [];
  const q = filter.value.trim().toUpperCase();
  if (!q) return companies.value.companies;
  return companies.value.companies.filter((c) => c.name.toUpperCase().includes(q) || c.tickers.some((t) => t.startsWith(q)));
});

// ---------- ETF ----------
const etfs = ref(null);
const etfQuery = ref('');
const etfResults = ref([]);
const holdings = ref(null);
const loadingHoldings = ref(false);
const equityOnly = ref(true);
let etfTimer = null;

watch(etfQuery, (q) => {
  clearTimeout(etfTimer);
  etfTimer = setTimeout(async () => {
    try {
      etfResults.value = (await api.browseEtfs(q)).etfs;
    } catch (e) {
      error.value = e.message;
    }
  }, 200);
});

async function loadHoldings() {
  if (!etf.value) {
    holdings.value = null;
    return;
  }
  loadingHoldings.value = true;
  error.value = null;
  try {
    holdings.value = await api.etfHoldings(etf.value);
    loadScores(holdings.value.holdings.map((h) => h.cik));
  } catch (e) {
    error.value = e.message;
    holdings.value = null;
  } finally {
    loadingHoldings.value = false;
  }
}
watch(etf, loadHoldings);

const visibleHoldings = computed(() => {
  if (!holdings.value) return [];
  const q = filter.value.trim().toUpperCase();
  return holdings.value.holdings.filter(
    (h) => (!equityOnly.value || h.assetCat === 'EC') && (!q || h.name.toUpperCase().includes(q) || (h.symbol || '').startsWith(q)),
  );
});
// copy the ETF's holdings (the ones with a ticker; all of them, or the top N
// by weight) into a custom ETF with the N-PORT weights, to be edited there
// The copy uses the freshest list the server can get (issuer daily file /
// index list, else this N-PORT) and remembers the ETF as the basket's source
// so it can be resynced later.
const copyN = ref('');
const copying = ref(false);
const copyable = computed(() => visibleHoldings.value.filter((h) => h.symbol && h.pctVal > 0));
async function copyToBasket() {
  const n = Number(copyN.value) > 0 ? Math.floor(Number(copyN.value)) : 0;
  const ticker = holdings.value.etf.ticker;
  copying.value = true;
  try {
    let rows;
    let sync = null;
    try {
      const live = await api.etfLive(ticker);
      const all = live.holdings.filter((h) => h.symbol && h.weight > 0).sort((a, b) => b.weight - a.weight);
      rows = (n ? all.slice(0, n) : all).map((h) => ({ ticker: h.symbol, cik: h.cik, name: h.name, weight: h.weight }));
      sync = { at: new Date().toISOString(), asOf: live.asOf, sourceName: live.source, added: [], removed: [], changed: 0 };
    } catch {
      rows = (n ? copyable.value.slice(0, n) : copyable.value).map((h) => ({ ticker: h.symbol, cik: h.cik, name: h.name, weight: h.pctVal }));
      sync = { at: new Date().toISOString(), asOf: holdings.value.filing.reportDate, sourceName: `N-PORT（${holdings.value.filing.reportDate}）`, added: [], removed: [], changed: 0 };
    }
    if (!rows.length) return;
    createBasket(`${ticker} 複製${n ? `（前 ${rows.length} 檔）` : ''}`, rows, { prune: true, source: { type: 'etf', ticker, n: n || null }, sync });
    emit('basket');
  } finally {
    copying.value = false;
  }
}
const popular = computed(() => {
  if (!etfs.value) return [];
  const by = new Map(etfs.value.etfs.map((e) => [e.ticker, e]));
  return etfs.value.popular.map((t) => by.get(t)).filter(Boolean);
});

const pct = (v) => (v == null ? '—' : `${v.toFixed(2)}%`);
const usd = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const money = (v) => (v == null ? '—' : usd.format(v / 1e6));
const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function pick(c) {
  cat.value = c;
  filter.value = '';
}

onMounted(async () => {
  try {
    const [s, f, e] = await Promise.all([api.browseSic(), api.browseFiler(), api.browseEtfs()]);
    sic.value = s;
    filer.value = f;
    etfs.value = e;
    etfResults.value = e.etfs;
    if (code.value) {
      openDivisions.value = new Set([s.codes.find((c) => c.code === code.value)?.division].filter(Boolean));
      nextTick(() => document.querySelector('.code.active')?.scrollIntoView({ block: 'center' }));
    } else openDivisions.value = new Set(['D']);
    nextTick(() => document.querySelector('.etf.active')?.scrollIntoView({ block: 'center' }));
  } catch (err) {
    error.value = err.message;
  }
  loadCompanies();
  loadHoldings();
});
</script>

<template>
  <div class="browse">
    <div class="tabs">
      <button :class="{ active: cat === 'sic' }" @click="pick('sic')">產業分類 (SIC)</button>
      <button :class="{ active: cat === 'filer' }" @click="pick('filer')">規模與申報身分</button>
      <button :class="{ active: cat === 'etf' }" @click="pick('etf')">ETF 成分股</button>
      <span v-if="sic" class="muted small src">資料：SEC Financial Statement Data Sets {{ sic.datasets.join(' / ') }}，更新 {{ new Date(sic.updatedAt).toLocaleDateString() }}</span>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <!-- ===== SIC ===== -->
    <div v-if="cat === 'sic'" class="layout">
      <aside class="panel side">
        <input v-model="sicFilter" type="text" placeholder="搜尋代碼或產業名稱" />
        <label class="small"><input v-model="listedOnly" type="checkbox" /> 只列有股票代號的公司</label>
        <p v-if="!sic" class="muted small">讀取產業清單…</p>
        <div v-for="d in sicGroups" :key="d.id" class="division">
          <div class="division-head" @click="toggleDivision(d.id)">
            <span class="caret">{{ openDivisions.has(d.id) || sicFilter ? '▾' : '▸' }}</span>
            {{ d.id }} · {{ d.zh }} <span class="muted small">({{ listedOnly ? d.listed : d.total }})</span>
          </div>
          <div v-if="openDivisions.has(d.id) || sicFilter" class="codes">
            <div v-for="c in d.codes" :key="c.code" class="code" :class="{ active: c.code === code }" :title="c.title" @click="code = c.code">
              <span class="mono">{{ c.code }}</span> {{ c.zh || c.title }}
              <span class="muted count">{{ listedOnly ? c.listed : c.total }}</span>
            </div>
          </div>
        </div>
      </aside>
      <main>
        <template v-if="selectedSic">
          <div class="panel meta">
            <div>
              <strong>SIC {{ selectedSic.code }} · {{ selectedSic.zh || selectedSic.title }}</strong>
              <div class="muted small">{{ selectedSic.title }}<span v-if="selectedSic.office"> · {{ selectedSic.office }}</span></div>
            </div>
            <div class="options">
              <input v-model="filter" type="text" placeholder="篩選代號 / 公司名" class="filter" />
              <span class="muted small">{{ visibleCompanies.length }} 家</span>
            </div>
          </div>
          <p v-if="loadingCompanies" class="muted">讀取公司清單…</p>
          <CompanyTable v-else-if="companies" :companies="visibleCompanies" :show-sic="false" :scores="scores" @open="emit('open', $event)" />
        </template>
        <p v-else class="empty muted">左邊選一個產業（SIC 4 碼），點公司即可進入財報。</p>
      </main>
    </div>

    <!-- ===== filer status ===== -->
    <div v-else-if="cat === 'filer'" class="layout">
      <aside class="panel side">
        <p class="muted small">
          SEC 依「公眾流通市值」（非關係人持股市值）把申報公司分成三種身分，決定 10-K / 10-Q 的申報期限與揭露要求。
        </p>
        <label class="small"><input v-model="listedOnly" type="checkbox" /> 只列有股票代號的公司</label>
        <p v-if="!filer" class="muted small">讀取分類…</p>
        <div v-for="c in filer?.categories || []" :key="c.key" class="card" :class="{ active: c.key === afs }" @click="afs = c.key">
          <div class="card-title">{{ c.zh }}</div>
          <div class="muted small">{{ c.label }}</div>
          <div class="small">{{ c.note }}</div>
          <div class="muted small">{{ listedOnly ? c.listed : c.total }} 家<span v-if="c.wksi"> · WKSI {{ c.wksi }}</span></div>
        </div>
        <p class="muted small">
          大型加速申報公司：10-K 年度結束後 60 天內、10-Q 40 天內申報；加速申報公司 75 / 40 天；非加速申報公司 90 / 45 天。WKSI（well-known seasoned issuer）為公眾流通市值 ≥ 7 億美元且符合條件、可自動生效發行的公司。
        </p>
      </aside>
      <main>
        <template v-if="afs && companies?.filer">
          <div class="panel meta">
            <div>
              <strong>{{ companies.filer.zh }}</strong> <span class="muted small">{{ companies.filer.label }}</span>
            </div>
            <div class="options">
              <input v-model="filter" type="text" placeholder="篩選代號 / 公司名" class="filter" />
              <span class="muted small">{{ visibleCompanies.length }} 家，依公眾流通市值排序</span>
            </div>
          </div>
          <p v-if="loadingCompanies" class="muted">讀取公司清單…</p>
          <CompanyTable v-else-if="companies" :companies="visibleCompanies" :show-afs="false" :scores="scores" @open="emit('open', $event)" />
        </template>
        <p v-else-if="loadingCompanies" class="muted">讀取公司清單…</p>
        <p v-else class="empty muted">左邊選一種申報身分。</p>
      </main>
    </div>

    <!-- ===== ETF ===== -->
    <div v-else class="layout">
      <aside class="panel side">
        <input v-model="etfQuery" type="text" placeholder="搜尋 ETF 代號 / 名稱 / 發行商" />
        <p class="muted small">
          清單來自 SEC 投資公司系列資料（{{ etfs ? `${etfs.total} 檔` : '…' }}）；成分股取自各基金最新的 Form N-PORT（每季申報，落後約兩個月）。
        </p>
        <template v-if="!etfQuery && popular.length">
          <div class="muted small head">常用</div>
          <div v-for="e in popular" :key="e.ticker" class="etf" :class="{ active: e.ticker === etf }" @click="etf = e.ticker">
            <span class="mono">{{ e.ticker }}</span> <span class="small">{{ e.name }}</span>
          </div>
          <div class="muted small head">全部（A–Z）</div>
        </template>
        <div class="etf-list">
          <div v-for="e in etfResults" :key="e.ticker" class="etf" :class="{ active: e.ticker === etf }" :title="e.entity" @click="etf = e.ticker">
            <span class="mono">{{ e.ticker }}</span> <span class="small">{{ e.name }}</span>
          </div>
          <p v-if="etfs && etfResults.length >= 300" class="muted small">只顯示前 300 筆，請輸入代號縮小範圍。</p>
        </div>
      </aside>
      <main>
        <p v-if="loadingHoldings" class="muted">下載 {{ etf }} 的 N-PORT 並比對成分股…（第一次需下載 CUSIP 對照，約 10 秒）</p>
        <template v-else-if="holdings">
          <div class="panel meta">
            <div>
              <strong>{{ holdings.etf.ticker }} · {{ holdings.etf.name }}</strong>
              <div class="muted small">
                {{ holdings.etf.entity }} · 持股日 {{ holdings.filing.reportDate }} · 申報 {{ holdings.filing.filingDate }} ·
                淨資產 {{ money(holdings.filing.netAssets) }} 百萬美元 ·
                <a :href="holdings.filing.viewerUrl" target="_blank" rel="noopener">N-PORT</a> ·
                <a :href="api.etfHoldingsUrl(holdings.etf.ticker)" target="_blank" rel="noopener">JSON</a>
              </div>
            </div>
            <div class="options">
              <label class="small"><input v-model="equityOnly" type="checkbox" /> 只看股票</label>
              <input v-model="filter" type="text" placeholder="篩選代號 / 名稱" class="filter" />
              <span class="muted small">{{ visibleHoldings.length }} 筆 · 可查財報 {{ holdings.stats.mapped }}/{{ holdings.stats.total }}</span>
              <span class="copy" title="把成分股（依權重排序、有代號的）複製成自製 ETF，權重照 N-PORT 比例換算成 100%，之後可以自己增減、改權重；留空 = 全部">
                前 <input v-model="copyN" type="number" min="1" class="n" :placeholder="String(copyable.length)" /> 檔
                <button class="small" :disabled="!copyable.length || copying" @click="copyToBasket">{{ copying ? '抓最新成分…' : `${Number(copyN) > 0 ? `前 ${Math.min(Number(copyN), copyable.length)} 檔` : '全部'}複製成自製 ETF` }}</button>
              </span>
            </div>
          </div>
          <div class="wrap">
            <table>
              <thead>
                <tr>
                  <th class="num">#</th>
                  <th class="star"></th>
                  <th>代號</th>
                  <th>評分</th>
                  <th>名稱</th>
                  <th class="num">權重</th>
                  <th class="num">市值 (百萬美元)</th>
                  <th class="num">股數</th>
                  <th>類別</th>
                  <th>國家</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(h, i) in visibleHoldings" :key="h.cusip || h.name + i" :class="{ row: h.cik, dim: !h.cik }" @click="h.cik && emit('open', { cik: h.cik, ticker: h.symbol })">
                  <td class="num muted small">{{ i + 1 }}</td>
                  <td class="star" @click.stop="h.cik && toggleWatch({ cik: h.cik, ticker: h.symbol, name: h.name })"><span v-if="h.cik" :class="{ on: isWatched(h.cik) }">{{ isWatched(h.cik) ? '★' : '☆' }}</span></td>
                  <td class="mono">
                    <a v-if="h.cik" :href="`?company=${h.symbol || h.cik}`" @click.prevent>{{ h.symbol || `CIK ${h.cik}` }}</a>
                    <span v-else class="muted" :title="h.cusip ? `CUSIP ${h.cusip}：找不到對應的 EDGAR 公司（外國公司、未上市或已下市）` : '無 CUSIP'">{{ h.symbol || '—' }}</span>
                  </td>
                  <td><ScoreBadge v-if="h.cik" :score="scores[h.cik] ?? null" /></td>
                  <td class="name">
                    {{ h.name }}<span v-if="h.title && h.title !== h.name" class="muted small"> · {{ h.title }}</span>
                  </td>
                  <td class="num">{{ pct(h.pctVal) }}</td>
                  <td class="num">{{ money(h.valUSD) }}</td>
                  <td class="num small">{{ h.balance == null ? '—' : num.format(h.balance) }}</td>
                  <td class="small">{{ h.assetZh || h.assetCat || '—' }}</td>
                  <td class="small muted">{{ h.country || '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="muted small note">
            灰色列為無法對應到 EDGAR 申報公司的持股（外國股票、已被收購下市、衍生性商品、現金等）。對應方式：N-PORT 的 CUSIP → SEC 交割失敗資料的股票代號 → EDGAR 公司；找不到時以名稱比對。
          </p>
        </template>
        <p v-else class="empty muted">左邊選一檔 ETF，點成分股即可進入財報。</p>
      </main>
    </div>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.src {
  margin-left: auto;
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
main {
  min-width: 0;
}
.side {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  overflow: auto;
  padding: 12px;
}
.side input[type='text'] {
  width: 100%;
  margin-bottom: 8px;
}
.side label {
  display: block;
  margin-bottom: 8px;
}
.division-head {
  cursor: pointer;
  font-weight: 600;
  padding: 6px 4px;
  border-top: 1px solid var(--border);
  user-select: none;
}
.caret {
  display: inline-block;
  width: 14px;
  color: var(--muted);
}
.code,
.etf {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 4px 6px 4px 18px;
  cursor: pointer;
  border-radius: 4px;
  font-size: 13px;
}
.etf {
  padding-left: 6px;
}
.code:hover,
.etf:hover {
  background: var(--accent-soft);
}
.code.active,
.etf.active {
  background: var(--accent);
  color: #fff;
}
.code.active .muted,
.etf.active .muted {
  color: #dbeafe;
}
.code .count {
  margin-left: auto;
  font-size: 11px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  cursor: pointer;
}
.card:hover {
  border-color: var(--accent);
}
.card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.card-title {
  font-weight: 600;
}
.head {
  margin: 10px 0 4px;
  font-weight: 600;
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
.options {
  display: flex;
  gap: 12px;
  align-items: center;
}
.filter {
  width: 200px;
  padding: 5px 8px;
}
.empty {
  text-align: center;
  padding: 80px 0;
}
.wrap {
  overflow: auto;
  max-height: calc(100vh - 260px);
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
  font-size: 13px;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.name {
  white-space: normal;
  min-width: 220px;
}
.row {
  cursor: pointer;
}
.row:hover td {
  background: var(--accent-soft);
}
.dim td {
  color: var(--muted);
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
tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.note {
  margin-top: 8px;
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
.copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.copy input.n {
  width: 56px;
  font: inherit;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  text-align: right;
}
.copy button.small {
  font-size: 12px;
  padding: 4px 10px;
}
</style>
