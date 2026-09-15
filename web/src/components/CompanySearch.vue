<script setup>
import { ref, watch } from 'vue';
import { api } from '../api';

const emit = defineEmits(['select']);
const query = ref('');
const results = ref([]);
const open = ref(false);
const loading = ref(false);
let timer = null;

watch(query, (q) => {
  clearTimeout(timer);
  if (!q.trim()) {
    results.value = [];
    return;
  }
  timer = setTimeout(async () => {
    loading.value = true;
    try {
      results.value = await api.search(q);
      open.value = true;
    } finally {
      loading.value = false;
    }
  }, 200);
});

function choose(row) {
  open.value = false;
  query.value = row.ticker;
  emit('select', row.ticker);
}

function submit() {
  const q = query.value.trim();
  if (!q) return;
  if (results.value.length && results.value[0].ticker.toUpperCase() === q.toUpperCase()) return choose(results.value[0]);
  open.value = false;
  emit('select', q);
}
</script>

<template>
  <div class="search">
    <input
      v-model="query"
      type="text"
      placeholder="輸入股票代號或公司名稱，例如 GOOGL、AAPL、TSM，或直接輸入 CIK"
      @keydown.enter="submit"
      @focus="results.length && (open = true)"
      @blur="setTimeout(() => (open = false), 150)"
    />
    <ul v-if="open && results.length" class="suggest">
      <li v-for="r in results" :key="r.ticker" @mousedown.prevent="choose(r)">
        <span class="ticker">{{ r.ticker }}</span>
        <span class="name">{{ r.name }}</span>
        <span class="muted mono">CIK {{ r.cik }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.search {
  position: relative;
}
.suggest {
  position: absolute;
  z-index: 10;
  top: 100%;
  left: 0;
  right: 0;
  margin: 4px 0 0;
  padding: 4px 0;
  list-style: none;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  max-height: 320px;
  overflow: auto;
}
.suggest li {
  display: grid;
  grid-template-columns: 90px 1fr auto;
  gap: 12px;
  padding: 8px 12px;
  cursor: pointer;
}
.suggest li:hover {
  background: var(--accent-soft);
}
.ticker {
  font-weight: 600;
}
</style>
