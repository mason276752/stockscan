<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import ScoreBadge from './ScoreBadge.vue';
import { removeWatch, watchlist } from '../watchlist';

const emit = defineEmits(['open']);
const scores = ref({});
const loading = ref(false);
const sortKey = ref('addedAt');
const sortDir = ref(-1);

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
  return [...watchlist.items].sort((a, b) => {
    const x = val(a) ?? -Infinity;
    const y = val(b) ?? -Infinity;
    if (x === y) return 0;
    return (x < y ? -1 : 1) * sortDir.value;
  });
});
const arrow = (k) => (sortKey.value === k ? (sortDir.value > 0 ? ' ▲' : ' ▼') : '');
const CATS = ['財務結構', '償債能力', '經營能力', '獲利能力', '現金流量'];
const catCls = (v) => (v == null ? '' : v >= 70 ? 'good' : v >= 40 ? 'mid' : 'bad');
</script>

<template>
  <div class="watch">
    <div class="panel meta">
      <div>
        <strong>觀察名單</strong> <span class="muted small">{{ watchlist.items.length }} 家 · 存在這個瀏覽器的 localStorage</span>
      </div>
      <div class="options">
        <button class="small" :disabled="loading || !watchlist.items.length" @click="refresh">{{ loading ? '更新中…' : '↻ 更新評分' }}</button>
      </div>
    </div>
    <p v-if="!watchlist.items.length" class="empty muted">還沒有加入任何公司。在財報頁公司名稱旁、分類瀏覽或 ETF 成分股的表格點 ☆ 就會加進來。</p>
    <div v-else class="wrap">
      <table>
        <thead>
          <tr>
            <th></th>
            <th class="sortable" @click="sortBy('ticker')">代號{{ arrow('ticker') }}</th>
            <th class="sortable" @click="sortBy('name')">公司{{ arrow('name') }}</th>
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
      評分 = 最新一份 10-K / 10-Q 依「財務指標」的判斷標準計分（五大類各 20 分：財務結構、償債能力、經營能力、獲利能力、現金流量；達標得滿分、差 20% 以內得一半），
      無法計算的項目不計、按剩餘項目換算成 100 分。背景爬蟲下載到新財報後評分會自動更新。銀行、保險等沒有流動資產概念的行業，償債、經營能力大多無法計算，分數僅供參考。
    </p>
  </div>
</template>

<style scoped>
.meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 16px;
  margin-bottom: 12px;
}
.small {
  font-size: 12px;
}
.empty {
  text-align: center;
  padding: 80px 0;
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
  min-width: 200px;
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
</style>
