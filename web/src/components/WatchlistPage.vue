<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import ScoreBadge from './ScoreBadge.vue';
import CompanySearch from './CompanySearch.vue';
import { addGroup, removeGroup, removeWatch, renameGroup, setGroups, toggleWatch, watchlist } from '../watchlist';

const emit = defineEmits(['open']);
const scores = ref({});
const loading = ref(false);
const sortKey = ref('addedAt');
const sortDir = ref(-1);
const current = ref('all'); // 'all' | '__none' | group name
const editing = ref(null); // cik whose group chips are being edited
const newGroup = ref('');
const renaming = ref(null); // { from, to }
const addMsg = ref('');

async function refresh() {
  if (!watchlist.items.length) return;
  loading.value = true;
  try {
    const r = await api.scores(watchlist.items.map((x) => x.cik));
    scores.value = r.scores;
  } catch {
    /* keep whatever we had */
  } finally {
    loading.value = false;
  }
}
onMounted(refresh);
watch(() => watchlist.items.length, refresh);

const counts = computed(() => {
  const c = { all: watchlist.items.length, __none: watchlist.items.filter((x) => !x.groups.length).length };
  for (const g of watchlist.groups) c[g] = watchlist.items.filter((x) => x.groups.includes(g)).length;
  return c;
});
const filtered = computed(() => {
  if (current.value === 'all') return watchlist.items;
  if (current.value === '__none') return watchlist.items.filter((x) => !x.groups.length);
  return watchlist.items.filter((x) => x.groups.includes(current.value));
});

function sortBy(k) {
  if (sortKey.value === k) sortDir.value = -sortDir.value;
  else {
    sortKey.value = k;
    sortDir.value = k === 'ticker' || k === 'name' ? 1 : -1;
  }
}
const rows = computed(() => {
  const k = sortKey.value;
  const val = (x) => {
    const s = scores.value[x.cik];
    if (k === 'score') return s?.score ?? null;
    if (k === 'periodEnd') return s?.periodEnd ?? '';
    if (k === 'filingDate') return s?.filingDate ?? '';
    return x[k] ?? '';
  };
  return [...filtered.value].sort((a, b) => {
    const x = val(a) ?? -Infinity;
    const y = val(b) ?? -Infinity;
    if (x === y) return 0;
    return (x < y ? -1 : 1) * sortDir.value;
  });
});
const arrow = (k) => (sortKey.value === k ? (sortDir.value > 0 ? ' ▲' : ' ▼') : '');
const CATS = ['財務結構', '償債能力', '經營能力', '獲利能力', '現金流量'];
const catCls = (v) => (v == null ? '' : v >= 70 ? 'good' : v >= 40 ? 'mid' : 'bad');

// ---- groups ----
function createGroup() {
  const g = addGroup(newGroup.value);
  if (g) current.value = g;
  newGroup.value = '';
}
function toggleInGroup(item, g) {
  const has = item.groups.includes(g);
  setGroups(item.cik, has ? item.groups.filter((x) => x !== g) : [...item.groups, g]);
}
function startRename(g) {
  renaming.value = { from: g, to: g };
}
function finishRename() {
  if (renaming.value && renameGroup(renaming.value.from, renaming.value.to) && current.value === renaming.value.from) current.value = renaming.value.to;
  renaming.value = null;
}
function deleteGroup(g) {
  if (!confirm(`刪除分類「${g}」？股票會留在名單中，只是不再屬於這個分類。`)) return;
  removeGroup(g);
  if (current.value === g) current.value = 'all';
}
// add a company straight into the current group from the search box
async function addFromSearch(ticker) {
  addMsg.value = '';
  try {
    const c = await api.company(ticker);
    const group = current.value !== 'all' && current.value !== '__none' ? current.value : null;
    toggleWatch({ cik: c.cik, ticker: c.tickers?.[0] || null, name: c.name }, group);
    addMsg.value = `已加入 ${c.tickers?.[0] || c.name}${group ? ` → ${group}` : ''}`;
  } catch (e) {
    addMsg.value = `找不到：${e.message}`;
  }
}
</script>

<template>
  <div class="watch">
    <div class="layout">
      <aside class="panel side">
        <div class="side-head">分類</div>
        <div class="group" :class="{ active: current === 'all' }" @click="current = 'all'">全部 <span class="muted">{{ counts.all }}</span></div>
        <div v-for="g in watchlist.groups" :key="g" class="group" :class="{ active: current === g }" @click="current = g">
          <template v-if="renaming?.from === g">
            <input v-model="renaming.to" type="text" class="rename" @keyup.enter="finishRename" @keyup.esc="renaming = null" @blur="finishRename" @click.stop />
          </template>
          <template v-else>
            <span class="gname">{{ g }}</span> <span class="muted">{{ counts[g] }}</span>
            <span class="tools">
              <button class="mini" title="改名" @click.stop="startRename(g)">✎</button>
              <button class="mini" title="刪除分類" @click.stop="deleteGroup(g)">✕</button>
            </span>
          </template>
        </div>
        <div class="group" :class="{ active: current === '__none' }" @click="current = '__none'">未分類 <span class="muted">{{ counts.__none }}</span></div>
        <div class="newgroup">
          <input v-model="newGroup" type="text" placeholder="新增分類，例如 航運股" @keyup.enter="createGroup" />
          <button class="mini" :disabled="!newGroup.trim()" @click="createGroup">新增</button>
        </div>
        <div class="side-head">加入股票</div>
        <CompanySearch @select="addFromSearch" />
        <p class="muted small">{{ addMsg || (current !== 'all' && current !== '__none' ? `搜尋後直接加入「${current}」` : '搜尋後加入名單（未分類）') }}</p>
        <p class="muted small">名單與分類存在這個瀏覽器的 localStorage。</p>
      </aside>

      <main>
        <div class="panel meta">
          <div>
            <strong>{{ current === 'all' ? '觀察名單' : current === '__none' ? '未分類' : current }}</strong>
            <span class="muted small">{{ rows.length }} 家</span>
          </div>
          <div class="options">
            <button class="small" :disabled="loading || !watchlist.items.length" @click="refresh">{{ loading ? '更新中…' : '↻ 更新評分' }}</button>
          </div>
        </div>
        <p v-if="!rows.length" class="empty muted">
          {{ watchlist.items.length ? '這個分類還沒有股票：在列上點「分類」勾選，或在左邊搜尋後直接加入。' : '還沒有加入任何公司。在財報頁公司名稱旁、分類瀏覽、ETF 成分股或尋找股票的表格點 ☆，或在左邊搜尋加入。' }}
        </p>
        <div v-else class="wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th class="sortable" @click="sortBy('ticker')">代號{{ arrow('ticker') }}</th>
                <th class="sortable" @click="sortBy('name')">公司{{ arrow('name') }}</th>
                <th>分類</th>
                <th class="sortable" title="最新一份已下載財報的評分" @click="sortBy('score')">評分{{ arrow('score') }}</th>
                <th v-for="c in CATS" :key="c" class="num cat">{{ c }}</th>
                <th class="sortable" @click="sortBy('periodEnd')">最新財報{{ arrow('periodEnd') }}</th>
                <th class="sortable" @click="sortBy('filingDate')">申報日{{ arrow('filingDate') }}</th>
                <th class="sortable" @click="sortBy('addedAt')">加入{{ arrow('addedAt') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="x in rows" :key="x.cik" class="row" @click="emit('open', x)">
                <td class="star" title="從觀察名單移除" @click.stop="removeWatch(x.cik)">★</td>
                <td class="mono"><a :href="`?company=${x.ticker || x.cik}`" @click.prevent>{{ x.ticker || `CIK ${x.cik}` }}</a></td>
                <td class="name">{{ x.name }}</td>
                <td class="groups" @click.stop>
                  <template v-if="editing === x.cik">
                    <label v-for="g in watchlist.groups" :key="g" class="chip edit"><input type="checkbox" :checked="x.groups.includes(g)" @change="toggleInGroup(x, g)" /> {{ g }}</label>
                    <span v-if="!watchlist.groups.length" class="muted small">先在左邊新增分類</span>
                    <button class="mini" @click="editing = null">完成</button>
                  </template>
                  <template v-else>
                    <span v-for="g in x.groups" :key="g" class="chip">{{ g }}</span>
                    <button class="mini ghost" @click="editing = x.cik">{{ x.groups.length ? '編輯' : '分類…' }}</button>
                  </template>
                </td>
                <td><ScoreBadge :score="scores[x.cik] ?? null" /></td>
                <td v-for="(c, i) in CATS" :key="c" class="num small" :class="catCls(scores[x.cik]?.categories?.[i])">{{ scores[x.cik]?.categories?.[i] ?? '—' }}</td>
                <td class="small">
                  <template v-if="scores[x.cik]">{{ scores[x.cik].form }} {{ scores[x.cik].fiscalYear }} {{ scores[x.cik].fiscalPeriod }} <span class="muted">期末 {{ scores[x.cik].periodEnd }}</span></template>
                  <span v-else class="muted">尚未下載</span>
                </td>
                <td class="small">{{ scores[x.cik]?.filingDate || '—' }}</td>
                <td class="small muted">{{ x.addedAt?.slice(0, 10) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="muted small note">
          評分 = 最新一份 10-K / 10-Q 依「財務指標」的判斷標準計分（五大類各 20 分；達標得滿分、差 20% 以內得一半），無法計算的項目不計、按剩餘項目換算成 100 分。
          背景爬蟲下載到新財報後評分會自動更新。金融業多項無法計算，分數僅供參考。
        </p>
      </main>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 16px;
  align-items: start;
}
main {
  min-width: 0;
}
.side {
  padding: 12px;
  position: sticky;
  top: 16px;
}
.side-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin: 6px 0;
}
.group {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.group:hover {
  background: var(--accent-soft);
}
.group.active {
  background: var(--accent);
  color: #fff;
}
.group.active .muted {
  color: #dbeafe;
}
.group .gname {
  flex: 1;
}
.group .tools {
  display: none;
  gap: 2px;
}
.group:hover .tools {
  display: inline-flex;
}
.group.active .tools button {
  color: #fff;
  border-color: rgba(255, 255, 255, 0.5);
  background: transparent;
}
.rename {
  flex: 1;
  font: inherit;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.newgroup {
  display: flex;
  gap: 6px;
  margin: 8px 0 14px;
}
.newgroup input {
  flex: 1;
  font: inherit;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.mini {
  font-size: 11px;
  padding: 2px 7px;
}
.mini.ghost {
  border-style: dashed;
  color: var(--muted);
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
.meta .small {
  margin-left: 8px;
}
.small {
  font-size: 12px;
}
.empty {
  text-align: center;
  padding: 60px 20px;
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
.sortable {
  cursor: pointer;
  user-select: none;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
th.cat {
  font-weight: normal;
  font-size: 12px;
  color: var(--muted);
}
.name {
  white-space: normal;
  min-width: 180px;
}
.groups {
  white-space: normal;
  min-width: 140px;
  max-width: 320px;
}
.chip {
  display: inline-block;
  font-size: 11px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 10px;
  padding: 1px 8px;
  margin: 1px 4px 1px 0;
}
.chip.edit {
  background: var(--total);
  color: var(--text);
  cursor: pointer;
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
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
td.star {
  color: #f59e0b;
  cursor: pointer;
  text-align: center;
  width: 28px;
}
td.good {
  color: #166534;
}
td.mid {
  color: #854d0e;
}
td.bad {
  color: #991b1b;
}
.note {
  margin-top: 10px;
}
@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
  }
}
</style>
