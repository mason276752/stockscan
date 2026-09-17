<script setup>
// A loading message with a spinner. Every place that used to show a bare
// "loading…" line uses this, so nothing looks frozen: the ring turns, and
// the top bar (App.vue) runs while any of these is mounted. While the data
// worker of the static build is downloading something big, the bytes so far
// show next to the message.
import { onMounted, onUnmounted } from 'vue';
import { busy, download, mb } from '../busy';

defineProps({
  text: { type: String, default: '' },
  small: { type: Boolean, default: false }, // 12px text, 12px ring (inside buttons / small lines)
  inline: { type: Boolean, default: false }, // <span> instead of a <p>
});
onMounted(() => busy.count++);
onUnmounted(() => busy.count--);
</script>

<template>
  <component :is="inline ? 'span' : 'p'" class="loading muted" :class="{ small, inline }" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <span v-if="text" class="text">{{ text }}</span>
    <span v-if="download.total > 0" class="bytes">{{ mb(download.loaded) }} / {{ mb(download.total) }} MB</span>
  </component>
</template>

<style scoped>
.loading {
  display: flex;
  align-items: center;
  gap: 8px;
}
.loading.inline {
  display: inline-flex;
  gap: 6px;
  vertical-align: middle;
}
.loading.small {
  font-size: 12px;
}
.bytes {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}
.loading.small .spinner {
  width: 12px;
  height: 12px;
  border-width: 2px;
}
</style>
