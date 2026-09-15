<script setup>
import { computed } from 'vue';

const props = defineProps({
  filings: { type: Array, required: true },
  selected: { type: String, default: null }, // accession
});
const emit = defineEmits(['select', 'select-quarters']);

const PERIODS = ['Q1', 'Q2', 'Q3', 'FY'];
const canDerive = (slots) => PERIODS.every((p) => slots[p]);

// fiscal year -> { Q1: filing, Q2: ..., FY: ... }  (newest year first)
const years = computed(() => {
  const map = new Map();
  for (const f of props.filings) {
    if (!f.fiscalYear) continue;
    if (!map.has(f.fiscalYear)) map.set(f.fiscalYear, {});
    const slot = map.get(f.fiscalYear);
    // amendments (10-K/A) come later; keep the original unless nothing else
    if (!slot[f.fiscalPeriod] || !f.form.endsWith('/A')) slot[f.fiscalPeriod] = f;
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]);
});
</script>

<template>
  <div class="picker">
    <div class="head">
      <span class="year-col"></span>
      <span v-for="p in PERIODS" :key="p" class="period-col">{{ p }}</span>
      <span class="period-col" title="FY − Q1 − Q2 − Q3 推算">Q4*</span>
    </div>
    <div v-for="[year, slots] in years" :key="year" class="row">
      <span class="year-col">{{ year }}</span>
      <span v-for="p in PERIODS" :key="p" class="period-col">
        <button
          v-if="slots[p]"
          :class="{ active: slots[p].accession === selected }"
          :title="`${slots[p].form}  期末 ${slots[p].reportDate}  申報 ${slots[p].filingDate}`"
          @click="emit('select', slots[p])"
        >
          {{ slots[p].form }}
        </button>
        <span v-else class="muted">—</span>
      </span>
      <span class="period-col">
        <button
          v-if="canDerive(slots)"
          class="derived"
          :class="{ active: selected === `q4-${year}` }"
          title="用 10-K 減 Q1–Q3 10-Q 推算第四季"
          @click="emit('select-quarters', year)"
        >
          推算
        </button>
        <span v-else class="muted">—</span>
      </span>
    </div>
    <p v-if="!years.length" class="muted">這家公司沒有 Inline XBRL 財報。</p>
    <p class="muted hint">Q4* = FY − Q1 − Q2 − Q3，需要該年度四份申報齊全。</p>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.head,
.row {
  display: grid;
  grid-template-columns: 52px repeat(5, 1fr);
  gap: 6px;
  align-items: center;
}
.head {
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
.year-col {
  font-weight: 600;
}
.period-col {
  text-align: center;
}
.period-col button {
  width: 100%;
  padding: 5px 2px;
  font-size: 11px;
  white-space: nowrap;
}
.period-col button.derived {
  border-style: dashed;
}
.hint {
  font-size: 12px;
  margin: 4px 0 0;
}
</style>
