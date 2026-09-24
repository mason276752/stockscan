<script setup lang="ts">
// Small coloured pill for a company's latest-filing score.
import { api } from '../api';
import { t, tr } from '../i18n';
const props = defineProps({
  score: { type: Object, default: null }, // { score, coverage, form, fiscalYear, fiscalPeriod, categories[] } or null
});
const CATS = ['財務結構', '償債能力', '經營能力', '獲利能力', '現金流量'];
const cls = (s) => (s == null ? 'none' : s >= 70 ? 'good' : s >= 40 ? 'mid' : 'bad');
const title = () => {
  if (!props.score) return t(api.isStatic ? 'sb.noneStatic' : 'sb.none');
  const c = props.score.categories.map((v, i) => `${tr(CATS[i])} ${v == null ? '—' : v}`).join(t('sep'));
  return `${props.score.form} ${props.score.fiscalYear} ${props.score.fiscalPeriod} (${t('meta.periodEnd')} ${props.score.periodEnd})\n${c}\n${t('sb.coverage', { n: props.score.coverage })}`;
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
  background: var(--good-soft);
  color: var(--good);
}
.mid {
  background: var(--mid-soft);
  color: var(--mid);
}
.bad {
  background: var(--neg-soft);
  color: var(--bad);
}
.none {
  background: var(--total);
  color: var(--muted);
}
</style>
