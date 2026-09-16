<script setup>
// A searchable SIC picker: type a code, a Chinese name or the SEC English
// title, pick from the matches. v-model is the 4-digit code ('' = none).
import { computed, ref, watch } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  codes: { type: Array, default: () => [] }, // [{ code, zh, title, division, listed, total }]
  divisions: { type: Array, default: () => [] }, // [{ id, zh }]
  placeholder: { type: String, default: '輸入代碼或名稱搜尋…' },
  countKey: { type: String, default: 'listed' },
});
const emit = defineEmits(['update:modelValue']);

const query = ref('');
const open = ref(false);
const active = ref(0);
const label = (c) => `${c.code} ${c.zh || c.title}`;
const chosen = computed(() => props.codes.find((c) => c.code === props.modelValue) || null);
watch(chosen, (c) => (query.value = c ? label(c) : ''), { immediate: true });

const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (chosen.value && q === label(chosen.value).toLowerCase()) return [];
  // Chinese: every character of the query somewhere in the name ("製藥" finds 藥品製劑); Latin: substring
  const cjk = [...q].filter((ch) => /[\u3400-\u9fff]/.test(ch));
  const hit = (c) => {
    if (!q) return true;
    if (c.code.startsWith(q) || (c.title || '').toLowerCase().includes(q)) return true;
    const zh = c.zh || '';
    if (zh.toLowerCase().includes(q)) return true;
    return cjk.length > 0 && cjk.every((ch) => zh.includes(ch));
  };
  const rows = props.codes.filter(hit);
  // exact / prefix hits first
  rows.sort((a, b) => Number((b.zh || '').toLowerCase().includes(q) || b.code.startsWith(q)) - Number((a.zh || '').toLowerCase().includes(q) || a.code.startsWith(q)));
  return rows.slice(0, 40);
});
const divisionZh = (id) => props.divisions.find((d) => d.id === id)?.zh || id;

function choose(c) {
  emit('update:modelValue', c.code);
  query.value = label(c);
  open.value = false;
}
function clear() {
  emit('update:modelValue', '');
  query.value = '';
  open.value = false;
}
function onInput() {
  open.value = true;
  active.value = 0;
  if (!query.value.trim() && props.modelValue) emit('update:modelValue', '');
}
function onKey(e) {
  if (!open.value || !matches.value.length) return;
  if (e.key === 'ArrowDown') active.value = (active.value + 1) % matches.value.length;
  else if (e.key === 'ArrowUp') active.value = (active.value - 1 + matches.value.length) % matches.value.length;
  else if (e.key === 'Enter') choose(matches.value[active.value]);
  else if (e.key === 'Escape') open.value = false;
  else return;
  e.preventDefault();
}
function onBlur() {
  setTimeout(() => {
    open.value = false;
    if (!chosen.value) query.value = '';
    else query.value = label(chosen.value);
  }, 150);
}
</script>

<template>
  <div class="picker">
    <input v-model="query" type="text" :placeholder="placeholder" @input="onInput" @focus="open = true" @keydown="onKey" @blur="onBlur" />
    <button v-if="modelValue" class="clear" title="清除" @mousedown.prevent="clear">✕</button>
    <ul v-if="open && matches.length" class="suggest">
      <li v-for="(c, i) in matches" :key="c.code" :class="{ active: i === active }" @mousedown.prevent="choose(c)">
        <span class="mono">{{ c.code }}</span>
        <span class="name">{{ c.zh || c.title }}<span v-if="c.zh && c.title" class="muted en"> {{ c.title }}</span></span>
        <span class="muted small">{{ divisionZh(c.division) }} · {{ c[countKey] ?? c.listed }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.picker {
  position: relative;
  flex: 1;
  min-width: 0;
}
input {
  width: 100%;
  font: inherit;
  font-size: 13px;
  padding: 5px 26px 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}
input:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}
.clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 4px;
  font-size: 12px;
}
.suggest {
  position: absolute;
  z-index: 20;
  top: 100%;
  left: 0;
  right: 0;
  min-width: 320px;
  margin: 4px 0 0;
  padding: 4px 0;
  list-style: none;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  max-height: 300px;
  overflow: auto;
}
li {
  display: grid;
  grid-template-columns: 44px 1fr auto;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 13px;
  align-items: baseline;
}
li:hover,
li.active {
  background: var(--accent-soft);
}
.name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.en {
  font-size: 11px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.small {
  font-size: 11px;
  white-space: nowrap;
}
</style>
