<script setup>
// Small coloured pill for a company's latest-filing score.
const props = defineProps({
  score: { type: Object, default: null }, // { score, coverage, form, fiscalYear, fiscalPeriod, categories[] } or null
});
const CATS = ['財務結構', '償債能力', '經營能力', '獲利能力', '現金流量'];
const cls = (s) => (s == null ? 'none' : s >= 70 ? 'good' : s >= 40 ? 'mid' : 'bad');
const title = () => {
  if (!props.score) return '尚未下載最新財報（背景爬蟲會補上）';
  const c = props.score.categories.map((v, i) => `${CATS[i]} ${v == null ? '—' : v}`).join('、');
  return `${props.score.form} ${props.score.fiscalYear} ${props.score.fiscalPeriod}（期末 ${props.score.periodEnd}）\n${c}\n評分涵蓋 ${props.score.coverage}/100 分的項目`;
};
</script>

<template>
  <span class="badge" :class="cls(score?.score)" :title="title()">
    {{ score?.score ?? '—' }}<span v-if="score" class="period">{{ score.fiscalYear }} {{ score.fiscalPeriod }}</span>
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 1px 8px;
  border-radius: 10px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: 12px;
  white-space: nowrap;
}
.period {
  font-weight: normal;
  font-size: 10px;
  opacity: 0.8;
}
.good {
  background: #dcfce7;
  color: #166534;
}
.mid {
  background: #fef9c3;
  color: #854d0e;
}
.bad {
  background: #fee2e2;
  color: #991b1b;
}
.none {
  background: var(--total);
  color: var(--muted);
}
</style>
