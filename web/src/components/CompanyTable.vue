<script setup>
import { computed, ref } from 'vue';

import ScoreBadge from './ScoreBadge.vue';
import { isWatched, toggleWatch } from '../watchlist';

const props = defineProps({
  companies: { type: Array, required: true },
  showSic: { type: Boolean, default: true },
  showAfs: { type: Boolean, default: true },
  scores: { type: Object, default: () => ({}) }, // cik -> score summary | null
});
const emit = defineEmits(['open']);

const AFS_ZH = { LAF: '大型加速', ACC: '加速', NON: '非加速' };
const sortKey = ref('float');
const sortDir = ref(-1);

function sortBy(key) {
  if (sortKey.value === key) sortDir.value = -sortDir.value;
  else {
    sortKey.value = key;
    sortDir.value = key === 'name' || key === 'ticker' ? 1 : -1;
  }
}

const rows = computed(() => {
  const k = sortKey.value;
  const d = sortDir.value;
  const val = (c) => (k === 'score' ? props.scores[c.cik]?.score ?? null : c[k]);
  return [...props.companies].sort((a, b) => {
    const x = val(a) ?? (typeof val(b) === 'number' ? -Infinity : '');
    const y = val(b) ?? (typeof val(a) === 'number' ? -Infinity : '');
    if (x === y) return a.name.localeCompare(b.name);
    return (x < y ? -1 : 1) * d;
  });
});

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmtFloat = (v) => {
  if (v == null) return '—';
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} 兆`;
  if (v >= 1e8) return `${grouped.format(v / 1e8)} 億`;
  if (v >= 1e6) return `${grouped.format(v / 1e6)} 百萬`;
  return `${(v / 1e6).toFixed(2)} 百萬`;
};
const fmtDate = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s || '—');
const arrow = (k) => (sortKey.value === k ? (sortDir.value > 0 ? ' ▲' : ' ▼') : '');
</script>

<template>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th class="star"></th>
          <th class="sortable" @click="sortBy('ticker')">代號{{ arrow('ticker') }}</th>
          <th class="sortable" title="最新一份財報的評分（0–100），依財務指標的判斷標準計分；尚未下載的顯示 —" @click="sortBy('score')">評分{{ arrow('score') }}</th>
          <th class="sortable" @click="sortBy('name')">公司{{ arrow('name') }}</th>
          <th v-if="showSic" class="sortable" @click="sortBy('sic')">產業 (SIC){{ arrow('sic') }}</th>
          <th v-if="showAfs" class="sortable" @click="sortBy('afs')">申報身分{{ arrow('afs') }}</th>
          <th class="num sortable" title="公眾流通市值（非關係人持有股份市值，10-K 揭露，決定申報身分）" @click="sortBy('float')">公眾流通市值 USD{{ arrow('float') }}</th>
          <th class="sortable" @click="sortBy('filed')">最新申報{{ arrow('filed') }}</th>
          <th>地區</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in rows" :key="c.cik" class="row" @click="emit('open', c)">
          <td class="star" @click.stop="toggleWatch(c)"><span :class="{ on: isWatched(c.cik) }" :title="isWatched(c.cik) ? '從觀察名單移除' : '加入觀察名單'">{{ isWatched(c.cik) ? '★' : '☆' }}</span></td>
          <td class="mono">
            <a :href="`?company=${c.ticker || c.cik}`" @click.prevent>{{ c.ticker || `CIK ${c.cik}` }}</a>
            <span v-if="c.tickers.length > 1" class="muted small"> +{{ c.tickers.length - 1 }}</span>
          </td>
          <td><ScoreBadge :score="scores[c.cik] ?? null" /></td>
          <td class="name">{{ c.name }}</td>
          <td v-if="showSic" class="small">
            <span v-if="c.sic">{{ c.sic }} {{ c.sicZh || c.sicTitle || '' }}</span>
            <span v-else class="muted">—</span>
          </td>
          <td v-if="showAfs" class="small">
            {{ AFS_ZH[c.afs] || (c.afs ? c.afs : '—') }}<span v-if="c.wksi" class="tag" title="Well-known seasoned issuer：可用自動生效的 S-3 註冊聲明">WKSI</span>
          </td>
          <td class="num" :title="c.floatAdjusted ? '申報的 EntityPublicFloat 疑似單位錯誤（大 1,000 倍），已除以 1,000' : ''">
            {{ fmtFloat(c.float) }}<span v-if="c.floatAdjusted" class="warn">*</span>
            <div v-if="c.floatDate" class="muted tiny">{{ c.floatDate }}</div>
          </td>
          <td class="small">{{ c.form }} {{ fmtDate(c.filed) }}</td>
          <td class="small muted">{{ [c.state, c.country].filter(Boolean).join(', ') }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="!companies.length" class="muted empty">沒有公司。</p>
  </div>
</template>

<style scoped>
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
.sortable {
  cursor: pointer;
  user-select: none;
}
.sortable:hover {
  color: var(--accent);
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
tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.small {
  font-size: 12px;
}
.tiny {
  font-size: 10px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
/* not "badge": that name would leak into ScoreBadge's root element through the scoped attribute */
.tag {
  display: inline-block;
  font-size: 10px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 3px;
  padding: 0 3px;
  margin-left: 4px;
  vertical-align: middle;
}
.warn {
  color: var(--neg);
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
.empty {
  padding: 24px;
  text-align: center;
}
</style>
