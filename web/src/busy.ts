// How many loading indicators are on screen right now (Loading.vue counts
// itself in and out). While it is above zero App.vue shows the thin bar
// across the top, so something is always visibly moving even when the
// message itself is scrolled out of view. In the static build the data
// worker also reports its downloads here (api.static.js), and while any is
// in flight the bar shows how far they are instead of just moving.
import { computed, reactive } from 'vue';

export const busy = reactive({ count: 0, downloads: {} }); // downloads: path -> { loaded, total } (bytes)

// the downloads in flight added up: total 0 when there is none
export const download = computed(() => {
  let loaded = 0;
  let total = 0;
  for (const d of Object.values(busy.downloads)) {
    loaded += d.loaded;
    total += d.total;
  }
  return { loaded, total };
});
export const mb = (n) => (n / 1048576).toFixed(1);
