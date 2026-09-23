<script setup>
import { computed } from 'vue';
import { t } from '../i18n';
import { collapseAmendments } from '../../../server/lib/filings.js';

const props = defineProps({
  filings: { type: Array, required: true },
  selected: { type: String, default: null }, // accession
});
const emit = defineEmits(['select', 'select-quarters']);

const PERIODS = ['Q1', 'Q2', 'Q3', 'FY'];
const canDerive = (slots) => PERIODS.every((p) => slots[p]);

// fiscal year -> { Q1: filing, Q2: ..., FY: ... }  (newest year first)
// A period that was amended shows its amendment - the numbers the company
// now stands behind - unless that one has no statements in it (`thin`, the
// Part III-only kind), when the original is all there is to show.
const years = computed(() => {
  const map = new Map();
  for (const f of collapseAmendments(props.filings)) {
    if (!f.fiscalYear) continue;
    if (!map.has(f.fiscalYear)) map.set(f.fiscalYear, {});
    map.get(f.fiscalYear)[f.fiscalPeriod] ??= f;
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]);
});
</script>

<template>
  <div class="picker">
    <div class="head">
      <span class="year-col"></span>
      <span v-for="p in PERIODS" :key="p" class="period-col">{{ p }}</span>
      <span class="period-col" :title="t('fp.q4Title')">Q4*</span>
    </div>
    <div v-for="[year, slots] in years" :key="year" class="row">
      <span class="year-col">{{ year }}</span>
      <span v-for="p in PERIODS" :key="p" class="period-col">
        <button
          v-if="slots[p]"
          :class="{ active: slots[p].accession === selected }"
          :title="`${slots[p].form}  ${t('meta.periodEnd')} ${slots[p].reportDate}  ${t('meta.filingDate')} ${slots[p].filingDate}`"
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
          :title="t('fp.deriveTitle')"
          @click="emit('select-quarters', year)"
        >
          {{ t('st.derived') }}
        </button>
        <span v-else class="muted">—</span>
      </span>
    </div>
    <p v-if="!years.length" class="muted">{{ t('fp.none') }}</p>
    <p class="muted hint">{{ t('fp.hint') }}</p>
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
