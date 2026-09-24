<script setup lang="ts">
// Score breakdown of one filing, shown above the indicators table.
import { computed, ref } from 'vue';
import { t, tr } from '../i18n';

const props = defineProps({ score: { type: Object, required: true } });
const open = ref(false);
const cls = (s) => (s == null ? 'none' : s >= 70 ? 'good' : s >= 40 ? 'mid' : 'bad');
const f1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const OP = { '>': '>', '>=': '≥', '<': '<', '<=': '≤' };
const unitOf = (it) => (it.unit === '%' ? '%' : it.unit === '元' ? '' : ` ${tr(it.unit)}`);
const fmtVal = (it) => (it.value == null ? '—' : `${f1.format(it.value)}${unitOf(it)}`);
const fmtBench = (it) => `${OP[it.benchmark.op]} ${it.benchmark.value}${unitOf(it)}`;
const gradeText = (g) => t(g == null ? 'sc.gradeNone' : g === 1 ? 'sc.gradeFull' : g === 0.5 ? 'sc.gradeHalf' : 'sc.gradeZero');
// the basis line from what the flows cover (the stored note is Chinese only):
// one quarter ×4 like the table, a full year, or - a quarterly filing scored
// alone because a neighbouring filing is not saved - its year-to-date column
const basisNote = computed(() => {
  const b = props.score.basis;
  const note = b.kind === 'quarter' ? t('sc.basisQuarter') : b.monthsLen === 12 ? t('sc.basisFull') : t('sc.basisYtd', { months: b.monthsLen, factor: (12 / b.monthsLen).toFixed(2) });
  return b.partial ? t('sc.basisPartial', { note }) : note;
});
const byCat = computed(() => props.score.categories.map((c) => ({ ...c, items: props.score.items.filter((i) => i.category === c.name) })));
</script>

<template>
  <div class="panel card">
    <div class="head" @click="open = !open">
      <div class="total" :class="cls(score.score)">
        <div class="num">{{ score.score ?? '—' }}</div>
        <div class="of">/ 100</div>
      </div>
      <div class="cats">
        <div v-for="c in score.categories" :key="c.name" class="cat">
          <div class="cat-name">{{ tr(c.name) }}</div>
          <div class="bar"><div class="fill" :class="cls(c.score)" :style="{ width: `${c.score ?? 0}%` }"></div></div>
          <div class="cat-val muted">{{ c.earned }} / {{ c.applicable }}</div>
        </div>
      </div>
      <div class="meta muted small">
        {{ score.form }} {{ score.fiscalYear }} {{ score.fiscalPeriod }} · {{ t('meta.periodEnd') }} {{ score.periodEnd }}<br />
        {{ basisNote }}<br />
        {{ t('sc.coverage', { n: score.coverage }) }} · <span class="link">{{ open ? t('sc.hide') : t('sc.show') }}</span>
      </div>
    </div>
    <div v-if="open" class="detail">
      <table>
        <thead>
          <tr>
            <th>{{ t('it.group') }}</th>
            <th>{{ t('sc.item') }}</th>
            <th class="num">{{ t('sc.value') }}</th>
            <th>{{ t('sc.benchmark') }}</th>
            <th>{{ t('sc.result') }}</th>
            <th class="num">{{ t('sc.points') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="c in byCat" :key="c.name">
            <tr v-for="(it, i) in c.items" :key="it.key" :class="{ first: i === 0 }">
              <td v-if="i === 0" :rowspan="c.items.length" class="catcell">{{ tr(c.name) }}</td>
              <td>{{ tr(it.name) }}</td>
              <td class="num">{{ fmtVal(it) }}</td>
              <td class="muted">{{ fmtBench(it) }}</td>
              <td :class="it.grade == null ? 'muted' : it.grade === 1 ? 'good-t' : it.grade === 0.5 ? 'mid-t' : 'bad-t'">{{ gradeText(it.grade) }}</td>
              <td class="num">{{ it.points == null ? '—' : `${it.points} / ${f1.format(it.weight)}` }}</td>
            </tr>
          </template>
        </tbody>
      </table>
      <p class="muted small">{{ t('sc.footnote') }}</p>
    </div>
  </div>
</template>

<style scoped>
.card {
  margin-bottom: 12px;
  padding: 12px 16px;
}
.head {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 20px;
  align-items: center;
  cursor: pointer;
}
.total {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 6px 14px;
  border-radius: 10px;
}
.total .num {
  font-size: 32px;
  font-weight: 700;
}
.total .of {
  font-size: 12px;
  opacity: 0.8;
}
.cats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
}
.cat-name {
  font-size: 12px;
  font-weight: 600;
}
.bar {
  height: 8px;
  background: var(--total);
  border-radius: 4px;
  overflow: hidden;
  margin: 4px 0;
}
.fill {
  height: 100%;
}
.cat-val {
  font-size: 11px;
}
.meta {
  text-align: right;
  line-height: 1.5;
}
.link {
  color: var(--accent);
}
.small {
  font-size: 12px;
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
.fill.good {
  background: var(--good-bar);
}
.fill.mid {
  background: var(--mid-bar);
}
.fill.bad {
  background: var(--bad-bar);
}
.detail {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}
th,
td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  white-space: nowrap;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.catcell {
  font-weight: 600;
  vertical-align: top;
}
.good-t {
  color: var(--good);
}
.mid-t {
  color: var(--mid);
}
.bad-t {
  color: var(--bad);
}
@media (max-width: 900px) {
  .head {
    grid-template-columns: auto 1fr;
  }
  .cats {
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
  }
  .meta {
    grid-column: 1 / -1;
    text-align: left;
  }
}
@media (max-width: 760px) {
  .cats {
    grid-template-columns: repeat(3, 1fr);
  }
  .detail {
    overflow-x: auto;
  }
}
</style>
