<script setup lang="ts">
// An explanatory paragraph: as is on a desktop, folded behind a "details"
// line on a phone so the tables stay near the top.
import { isPhone } from '../viewport';
import { t } from '../i18n';
</script>

<template>
  <details v-if="isPhone" class="note-fold">
    <summary class="muted small">{{ t('note.more') }}</summary>
    <p class="muted small note"><slot /></p>
  </details>
  <p v-else class="muted small note"><slot /></p>
</template>

<style scoped>
.note-fold {
  margin: -4px 0 10px;
}
.note-fold summary {
  cursor: pointer;
  list-style: none;
}
.note-fold summary::before {
  content: 'ⓘ ';
}
.note-fold summary::-webkit-details-marker {
  display: none;
}
.note-fold .note {
  margin: 4px 0 0;
}
</style>
