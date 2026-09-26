<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { api } from '../api';
import ScoreBadge from './ScoreBadge.vue';
import CompanySearch from './CompanySearch.vue';
import { addGroup, removeGroup, removeWatch, renameGroup, setGroups, toggleWatch, watchlist } from '../watchlist';
import { createBasket } from '../baskets';
import { t, tr } from '../i18n';
import Note from './Note.vue';
import Loading from './Loading.vue';
import type { ScoreBadge as ScoreBadgeData } from '../../../server/lib/types.ts';
import type { WatchEntry } from '../watchlist';

const emit = defineEmits(['open', 'basket', 'hover']);
const scores = shallowRef<Record<string, ScoreBadgeData | null>>({});
const loading = ref(false);
const sortKey = ref('addedAt');
const sortDir = ref(-1);
const current = ref('all'); // 'all' | '__none' | group name
const editing = ref<number | null>(null); // cik whose group chips are being edited
const newGroup = ref('');
const renaming = ref<{ from: string; to: string } | null>(null);
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
  const c: Record<string, number> = { all: watchlist.items.length, __none: watchlist.items.filter((x) => !x.groups.length).length };
  for (const g of watchlist.groups) c[g] = watchlist.items.filter((x) => x.groups.includes(g)).length;
  return c;
});
const filtered = computed(() => {
  if (current.value === 'all') return watchlist.items;
  if (current.value === '__none') return watchlist.items.filter((x) => !x.groups.length);
  return watchlist.items.filter((x) => x.groups.includes(current.value));
});

function sortBy(k: string) {
  if (sortKey.value === k) sortDir.value = -sortDir.value;
  else {
    sortKey.value = k;
    sortDir.value = k === 'ticker' || k === 'name' ? 1 : -1;
  }
}
const rows = computed(() => {
  const k = sortKey.value;
  const val = (x: WatchEntry): string | number | null => {
    const s = scores.value[x.cik];
    if (k === 'score') return s?.score ?? null;
    if (k === 'periodEnd') return s?.periodEnd ?? '';
    if (k === 'filingDate') return s?.filingDate ?? '';
    return (x as unknown as Record<string, string | number>)[k] ?? '';
  };
  return [...filtered.value].sort((a, b) => {
    const x = val(a) ?? -Infinity;
    const y = val(b) ?? -Infinity;
    if (x === y) return 0;
    return (x < y ? -1 : 1) * sortDir.value;
  });
});
const arrow = (k: string) => (sortKey.value === k ? (sortDir.value > 0 ? ' ▲' : ' ▼') : '');
const CATS = ['財務結構', '償債能力', '經營能力', '獲利能力', '現金流量'];
const catCls = (v: number | null | undefined) => (v == null ? '' : v >= 70 ? 'good' : v >= 40 ? 'mid' : 'bad');

// ---- groups ----
function createGroup() {
  const g = addGroup(newGroup.value);
  if (g) current.value = g;
  newGroup.value = '';
}
function toggleInGroup(item: WatchEntry, g: string) {
  const has = item.groups.includes(g);
  setGroups(item.cik, has ? item.groups.filter((x) => x !== g) : [...item.groups, g]);
}
function startRename(g: string) {
  renaming.value = { from: g, to: g };
}
function finishRename() {
  if (renaming.value && renameGroup(renaming.value.from, renaming.value.to) && current.value === renaming.value.from) current.value = renaming.value.to;
  renaming.value = null;
}
function deleteGroup(g: string) {
  if (!confirm(t('wl.confirmDeleteGroup', { g }))) return;
  removeGroup(g);
  if (current.value === g) current.value = 'all';
}
// the stocks on screen (a group, or the whole list) as a new custom ETF
function makeBasket() {
  const items = filtered.value.filter((x) => x.ticker);
  if (!items.length) return;
  const group = current.value === '__none' ? null : current.value;
  createBasket(current.value === 'all' ? t('nav.watch') : current.value === '__none' ? t('wl.ungrouped') : current.value, items, { prune: true, source: group ? { type: 'watch', group } : null });
  emit('basket');
}
// add a company straight into the current group from the search box
async function addFromSearch(ticker: string) {
  addMsg.value = '';
  try {
    const c = await api.company(ticker);
    const group = current.value !== 'all' && current.value !== '__none' ? current.value : null;
    toggleWatch({ cik: c.cik, ticker: c.tickers?.[0] || null, name: c.name }, group);
    addMsg.value = t('wl.added', { name: c.tickers?.[0] || c.name, group: group ? ` → ${group}` : '' });
  } catch (e) {
    addMsg.value = t('notFound', { msg: (e as Error).message });
  }
}
</script>

<template>
  <div class="watch">
    <div class="layout">
      <aside class="panel side">
        <div class="side-head">{{ t('wl.groups') }}</div>
        <div class="groups-list">
        <div class="group" :class="{ active: current === 'all' }" @click="current = 'all'">{{ t('wl.all') }} <span class="muted">{{ counts.all }}</span></div>
        <div v-for="g in watchlist.groups" :key="g" class="group" :class="{ active: current === g }" @click="current = g">
          <template v-if="renaming?.from === g">
            <input v-model="renaming.to" type="text" class="rename" @keyup.enter="finishRename" @keyup.esc="renaming = null" @blur="finishRename" @click.stop />
          </template>
          <template v-else>
            <span class="gname">{{ g }}</span> <span class="muted">{{ counts[g] }}</span>
            <span class="tools">
              <button class="mini" :title="t('rename')" @click.stop="startRename(g)">✎</button>
              <button class="mini" :title="t('wl.deleteGroup')" @click.stop="deleteGroup(g)">✕</button>
            </span>
          </template>
        </div>
        <div class="group" :class="{ active: current === '__none' }" @click="current = '__none'">{{ t('wl.ungrouped') }} <span class="muted">{{ counts.__none }}</span></div>
        </div>
        <div class="newgroup">
          <input v-model="newGroup" type="text" :placeholder="t('wl.newGroupPlaceholder')" @keyup.enter="createGroup" />
          <button class="mini" :disabled="!newGroup.trim()" @click="createGroup">{{ t('add') }}</button>
        </div>
        <div class="side-head">{{ t('wl.addStock') }}</div>
        <CompanySearch @select="addFromSearch" />
        <p class="muted small">{{ addMsg || (current !== 'all' && current !== '__none' ? t('wl.addToGroup', { g: current }) : t('wl.addUngrouped')) }}</p>
        <p class="muted small hide-p">{{ t('wl.storage') }}</p>
      </aside>

      <main>
        <div class="panel meta">
          <div>
            <strong>{{ current === 'all' ? t('nav.watch') : current === '__none' ? t('wl.ungrouped') : current }}</strong>
            <span class="muted small">{{ t('companies', { n: rows.length }) }}</span>
          </div>
          <div class="options">
            <button class="small" :disabled="!rows.length" :title="t('wl.makeBasketTitle')" @click="makeBasket">{{ t('makeBasket') }}</button>
            <button class="small" :disabled="loading || !watchlist.items.length" @click="refresh"><Loading v-if="loading" inline small :text="t('filings.refreshing')" /><template v-else>{{ t('wl.refreshScores') }}</template></button>
          </div>
        </div>
        <p v-if="!rows.length" class="empty muted">
          {{ watchlist.items.length ? t('wl.emptyGroup') : t('wl.emptyAll') }}
        </p>
        <div v-else class="wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th class="sortable" @click="sortBy('ticker')">{{ t('col.ticker') }}{{ arrow('ticker') }}</th>
                <th class="sortable" @click="sortBy('name')">{{ t('col.company') }}{{ arrow('name') }}</th>
                <th>{{ t('wl.groups') }}</th>
                <th class="sortable" :title="t('wl.scoreTitle')" @click="sortBy('score')">{{ t('col.score') }}{{ arrow('score') }}</th>
                <th v-for="c in CATS" :key="c" class="num cat hide-p">{{ tr(c) }}</th>
                <th class="sortable hide-p" @click="sortBy('periodEnd')">{{ t('wl.latestFiling') }}{{ arrow('periodEnd') }}</th>
                <th class="sortable hide-t" @click="sortBy('filingDate')">{{ t('meta.filingDate') }}{{ arrow('filingDate') }}</th>
                <th class="sortable hide-t" @click="sortBy('addedAt')">{{ t('wl.addedCol') }}{{ arrow('addedAt') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="x in rows" :key="x.cik" class="row" @click="emit('open', x)" @mouseenter="emit('hover', { cik: x.cik, ticker: x.ticker, accession: scores[x.cik]?.accession })" @mouseleave="emit('hover', null)">
                <td class="star" :title="t('watch.remove')" @click.stop="removeWatch(x.cik)">★</td>
                <td class="mono"><a :href="`?company=${x.ticker || x.cik}`" @click.prevent>{{ x.ticker || `CIK ${x.cik}` }}</a></td>
                <td class="name">{{ x.name }}</td>
                <td class="groups" @click.stop>
                  <template v-if="editing === x.cik">
                    <label v-for="g in watchlist.groups" :key="g" class="chip edit"><input type="checkbox" :checked="x.groups.includes(g)" @change="toggleInGroup(x, g)" /> {{ g }}</label>
                    <span v-if="!watchlist.groups.length" class="muted small">{{ t('wl.noGroups') }}</span>
                    <button class="mini" @click="editing = null">{{ t('done') }}</button>
                  </template>
                  <template v-else>
                    <span v-for="g in x.groups" :key="g" class="chip">{{ g }}</span>
                    <button class="mini ghost" @click="editing = x.cik">{{ x.groups.length ? t('edit') : t('wl.groupsEllipsis') }}</button>
                  </template>
                </td>
                <td><ScoreBadge :score="scores[x.cik] ?? null" /></td>
                <td v-for="(c, i) in CATS" :key="c" class="num small hide-p" :class="catCls(scores[x.cik]?.categories?.[i])">{{ scores[x.cik]?.categories?.[i] ?? '—' }}</td>
                <td class="small hide-p">
                  <template v-if="scores[x.cik]">{{ scores[x.cik]!.form }} {{ scores[x.cik]!.fiscalYear }} {{ scores[x.cik]!.fiscalPeriod }} <span class="muted">{{ t('meta.periodEnd') }} {{ scores[x.cik]!.periodEnd }}</span></template>
                  <span v-else class="muted">{{ t('wl.notDownloaded') }}</span>
                </td>
                <td class="small hide-t">{{ scores[x.cik]?.filingDate || '—' }}</td>
                <td class="small muted hide-t">{{ x.addedAt?.slice(0, 10) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Note>{{ t('wl.scoreNote') }} {{ t(api.isStatic ? 'wl.scoreRefreshStatic' : 'wl.scoreRefresh') }}</Note>
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
  color: var(--on-accent);
}
.group.active .muted {
  color: var(--accent-soft);
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
  color: var(--on-accent);
  border-color: var(--on-accent-soft);
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
  color: var(--star);
  cursor: pointer;
  text-align: center;
  width: 28px;
}
td.good {
  color: var(--good);
}
td.mid {
  color: var(--mid);
}
td.bad {
  color: var(--bad);
}
.note {
  margin-top: 10px;
}
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
  }
  /* the groups as a row of chips instead of a list */
  .groups-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .group {
    border: 1px solid var(--border);
    padding: 4px 10px;
    border-radius: 14px;
  }
  .group .tools {
    display: inline-flex;
  }
}
@media (max-width: 760px) {
  .wrap {
    max-height: none;
  }
  .meta .options {
    flex-wrap: wrap;
  }
  th,
  td {
    padding: 5px 6px;
  }
}
</style>
