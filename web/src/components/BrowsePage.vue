<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { createBasket } from '../baskets';
import CompanyTable from './CompanyTable.vue';
import ScoreBadge from './ScoreBadge.vue';
import { isWatched, toggleWatch } from '../watchlist';
import { dateLocale, isZh, pick, t, tr } from '../i18n';
import { isNarrow } from '../viewport';
import Note from './Note.vue';

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
      sync = { at: new Date().toISOString(), asOf: holdings.value.filing.reportDate, sourceName: `N-PORT (${holdings.value.filing.reportDate})`, added: [], removed: [], changed: 0 };
    }
    if (!rows.length) return;
    createBasket(t('br.copyName', { ticker, top: n ? t('br.copyNameTop', { n: rows.length }) : '' }), rows, { prune: true, source: { type: 'etf', ticker, n: n || null }, sync });
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

function pickCat(c) {
  cat.value = c;
  filter.value = '';
  sideOpen.value = !selected.value;
}
// small screens: the list panel is a drawer above the content, closed once
// something is picked and reopened from the bar that names the pick
const selected = computed(() => (cat.value === 'sic' ? code.value : cat.value === 'filer' ? afs.value : etf.value));
const sideOpen = ref(!selected.value);
watch(selected, (v) => {
  if (v && isNarrow.value) sideOpen.value = false;
});
const pickLabel = computed(() => {
  if (cat.value === 'sic') return selectedSic.value ? `SIC ${selectedSic.value.code} · ${pick(selectedSic.value, 'zh', 'title')}` : t('br.pickBarSic');
  if (cat.value === 'filer') return companies.value?.filer ? pick(companies.value.filer, 'zh', 'label') : t('br.pickBarFiler');
  return holdings.value ? `${holdings.value.etf.ticker} · ${holdings.value.etf.name}` : t('br.pickBarEtf');
});

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
      <button :class="{ active: cat === 'sic' }" @click="pickCat('sic')">{{ t('br.tabSic') }}</button>
      <button :class="{ active: cat === 'filer' }" @click="pickCat('filer')">{{ t('br.tabFiler') }}</button>
      <button :class="{ active: cat === 'etf' }" @click="pickCat('etf')">{{ t('br.tabEtf') }}</button>
      <span v-if="sic" class="muted small src">{{ t('br.dataSource', { sets: sic.datasets.join(' / '), date: new Date(sic.updatedAt).toLocaleDateString(dateLocale) }) }}</span>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <button v-if="isNarrow" class="pickbar" :class="{ open: sideOpen }" @click="sideOpen = !sideOpen"><span class="caret">{{ sideOpen ? '▾' : '▸' }}</span> {{ pickLabel }}</button>

    <!-- ===== SIC ===== -->
    <div v-if="cat === 'sic'" class="layout">
      <aside v-show="!isNarrow || sideOpen" class="panel side">
        <input v-model="sicFilter" type="text" :placeholder="t('br.sicSearch')" />
        <label class="small"><input v-model="listedOnly" type="checkbox" /> {{ t('listedOnly') }}</label>
        <p v-if="!sic" class="muted small">{{ t('br.loadingSic') }}</p>
        <div v-for="d in sicGroups" :key="d.id" class="division">
          <div class="division-head" @click="toggleDivision(d.id)">
            <span class="caret">{{ openDivisions.has(d.id) || sicFilter ? '▾' : '▸' }}</span>
            {{ d.id }} · {{ pick(d, 'zh', 'en') }} <span class="muted small">({{ listedOnly ? d.listed : d.total }})</span>
          </div>
          <div v-if="openDivisions.has(d.id) || sicFilter" class="codes">
            <div v-for="c in d.codes" :key="c.code" class="code" :class="{ active: c.code === code }" :title="c.title" @click="code = c.code">
              <span class="mono">{{ c.code }}</span> {{ pick(c, 'zh', 'title') }}
              <span class="muted count">{{ listedOnly ? c.listed : c.total }}</span>
            </div>
          </div>
        </div>
      </aside>
      <main>
        <template v-if="selectedSic">
          <div class="panel meta">
            <div>
              <strong>SIC {{ selectedSic.code }} · {{ pick(selectedSic, 'zh', 'title') }}</strong>
              <div class="muted small">{{ selectedSic.title }}<span v-if="selectedSic.office"> · {{ selectedSic.office }}</span></div>
            </div>
            <div class="options">
              <input v-model="filter" type="text" :placeholder="t('br.filterCompanies')" class="filter" />
              <span class="muted small">{{ t('companies', { n: visibleCompanies.length }) }}</span>
            </div>
          </div>
          <p v-if="loadingCompanies" class="muted">{{ t('br.loadingCompanies') }}</p>
          <CompanyTable v-else-if="companies" :companies="visibleCompanies" :show-sic="false" :scores="scores" @open="emit('open', $event)" />
        </template>
        <p v-else class="empty muted">{{ t('br.pickSic') }}</p>
      </main>
    </div>

    <!-- ===== filer status ===== -->
    <div v-else-if="cat === 'filer'" class="layout">
      <aside v-show="!isNarrow || sideOpen" class="panel side">
        <p class="muted small">{{ t('br.filerIntro') }}</p>
        <label class="small"><input v-model="listedOnly" type="checkbox" /> {{ t('listedOnly') }}</label>
        <p v-if="!filer" class="muted small">{{ t('br.loadingFiler') }}</p>
        <div v-for="c in filer?.categories || []" :key="c.key" class="card" :class="{ active: c.key === afs }" @click="afs = c.key">
          <div class="card-title">{{ pick(c, 'zh', 'label') }}</div>
          <div v-if="isZh" class="muted small">{{ c.label }}</div>
          <div class="small">{{ tr(c.note) }}</div>
          <div class="muted small">{{ t('companies', { n: listedOnly ? c.listed : c.total }) }}<span v-if="c.wksi"> · WKSI {{ c.wksi }}</span></div>
        </div>
        <p class="muted small hide-p">{{ t('br.filerDeadlines') }}</p>
      </aside>
      <main>
        <template v-if="afs && companies?.filer">
          <div class="panel meta">
            <div>
              <strong>{{ pick(companies.filer, 'zh', 'label') }}</strong> <span v-if="isZh" class="muted small">{{ companies.filer.label }}</span>
            </div>
            <div class="options">
              <input v-model="filter" type="text" :placeholder="t('br.filterCompanies')" class="filter" />
              <span class="muted small">{{ t('br.sortedByFloat', { n: visibleCompanies.length }) }}</span>
            </div>
          </div>
          <p v-if="loadingCompanies" class="muted">{{ t('br.loadingCompanies') }}</p>
          <CompanyTable v-else-if="companies" :companies="visibleCompanies" :show-afs="false" :scores="scores" @open="emit('open', $event)" />
        </template>
        <p v-else-if="loadingCompanies" class="muted">{{ t('br.loadingCompanies') }}</p>
        <p v-else class="empty muted">{{ t('br.pickFiler') }}</p>
      </main>
    </div>

    <!-- ===== ETF ===== -->
    <div v-else class="layout">
      <aside v-show="!isNarrow || sideOpen" class="panel side">
        <input v-model="etfQuery" type="text" :placeholder="t('br.etfSearch')" />
        <p class="muted small hide-p">{{ t('br.etfIntro', { n: etfs ? etfs.total : '…' }) }}</p>
        <template v-if="!etfQuery && popular.length">
          <div class="muted small head">{{ t('br.popular') }}</div>
          <div v-for="e in popular" :key="e.ticker" class="etf" :class="{ active: e.ticker === etf }" @click="etf = e.ticker">
            <span class="mono">{{ e.ticker }}</span> <span class="small">{{ e.name }}</span>
          </div>
          <div class="muted small head">{{ t('br.allAz') }}</div>
        </template>
        <div class="etf-list">
          <div v-for="e in etfResults" :key="e.ticker" class="etf" :class="{ active: e.ticker === etf }" :title="e.entity" @click="etf = e.ticker">
            <span class="mono">{{ e.ticker }}</span> <span class="small">{{ e.name }}</span>
          </div>
          <p v-if="etfs && etfResults.length >= 300" class="muted small">{{ t('br.first300') }}</p>
        </div>
      </aside>
      <main>
        <p v-if="loadingHoldings" class="muted">{{ t(api.isStatic ? 'br.loadingHoldingsStatic' : 'br.loadingHoldings', { etf }) }}</p>
        <template v-else-if="holdings">
          <div class="panel meta">
            <div>
              <strong>{{ holdings.etf.ticker }} · {{ holdings.etf.name }}</strong>
              <div class="muted small">
                {{ holdings.etf.entity }} · {{ t('br.holdingsDate') }} {{ holdings.filing.reportDate }} · {{ t('meta.filingDate') }} {{ holdings.filing.filingDate }} ·
                {{ t('br.netAssets') }} {{ money(holdings.filing.netAssets) }} {{ t('millionUsd') }} ·
                <a :href="holdings.filing.viewerUrl" target="_blank" rel="noopener">N-PORT</a> ·
                <a v-if="!api.isStatic" :href="api.etfHoldingsUrl(holdings.etf.ticker)" target="_blank" rel="noopener">JSON</a>
              </div>
            </div>
            <div class="options">
              <label class="small"><input v-model="equityOnly" type="checkbox" /> {{ t('br.equityOnly') }}</label>
              <input v-model="filter" type="text" :placeholder="t('br.filterHoldings')" class="filter" />
              <span class="muted small">{{ t('br.holdingsCount', { n: visibleHoldings.length, mapped: holdings.stats.mapped, total: holdings.stats.total }) }}</span>
              <span class="copy" :title="t('br.copyTitle')">
                {{ t('top') }} <input v-model="copyN" type="number" min="1" class="n" :placeholder="String(copyable.length)" /> {{ t('br.holdingsUnit') }}
                <button class="small" :disabled="!copyable.length || copying" @click="copyToBasket">{{ copying ? t(api.isStatic ? 'br.copyingStatic' : 'br.copying') : t('br.copyButton', { which: Number(copyN) > 0 ? t('br.copyTop', { n: Math.min(Number(copyN), copyable.length) }) : t('all') }) }}</button>
              </span>
            </div>
          </div>
          <div class="wrap">
            <table>
              <thead>
                <tr>
                  <th class="num">#</th>
                  <th class="star"></th>
                  <th>{{ t('col.ticker') }}</th>
                  <th>{{ t('col.score') }}</th>
                  <th>{{ t('col.name') }}</th>
                  <th class="num">{{ t('br.weight') }}</th>
                  <th class="num hide-p">{{ t('br.valueMusd') }}</th>
                  <th class="num hide-t">{{ t('br.sharesHeld') }}</th>
                  <th class="hide-p">{{ t('br.assetClass') }}</th>
                  <th class="hide-t">{{ t('br.country') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(h, i) in visibleHoldings" :key="h.cusip || h.name + i" :class="{ row: h.cik, dim: !h.cik }" @click="h.cik && emit('open', { cik: h.cik, ticker: h.symbol })">
                  <td class="num muted small">{{ i + 1 }}</td>
                  <td class="star" @click.stop="h.cik && toggleWatch({ cik: h.cik, ticker: h.symbol, name: h.name })"><span v-if="h.cik" :class="{ on: isWatched(h.cik) }">{{ isWatched(h.cik) ? '★' : '☆' }}</span></td>
                  <td class="mono">
                    <a v-if="h.cik" :href="`?company=${h.symbol || h.cik}`" @click.prevent>{{ h.symbol || `CIK ${h.cik}` }}</a>
                    <span v-else class="muted" :title="h.cusip ? t('br.noEdgar', { cusip: h.cusip }) : t('br.noCusip')">{{ h.symbol || '—' }}</span>
                  </td>
                  <td><ScoreBadge v-if="h.cik" :score="scores[h.cik] ?? null" /></td>
                  <td class="name">
                    {{ h.name }}<span v-if="h.title && h.title !== h.name" class="muted small"> · {{ h.title }}</span>
                  </td>
                  <td class="num">{{ pct(h.pctVal) }}</td>
                  <td class="num hide-p">{{ money(h.valUSD) }}</td>
                  <td class="num small hide-t">{{ h.balance == null ? '—' : num.format(h.balance) }}</td>
                  <td class="small hide-p">{{ (isZh ? h.assetZh : tr(h.assetZh)) || h.assetCat || '—' }}</td>
                  <td class="small muted hide-t">{{ h.country || '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <Note>{{ t('br.holdingsNote') }}</Note>
        </template>
        <p v-else class="empty muted">{{ t('br.pickEtf') }}</p>
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
.pickbar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  margin-bottom: 10px;
  font-weight: 600;
}
.pickbar.open {
  border-color: var(--accent);
}
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
    max-height: 60vh;
  }
}
@media (max-width: 760px) {
  .tabs {
    flex-wrap: wrap;
  }
  .tabs .src {
    display: none;
  }
  .meta .options {
    flex-wrap: wrap;
  }
  .wrap {
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
