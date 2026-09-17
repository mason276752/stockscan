// How many loading indicators are on screen right now (Loading.vue counts
// itself in and out). While it is above zero App.vue shows the thin
// indeterminate bar across the top, so something is always visibly moving
// even when the message itself is scrolled out of view.
import { reactive } from 'vue';

export const busy = reactive({ count: 0 });
