// Viewport class, reactive: the pages hide columns, collapse sidebars and
// shorten notes on small screens. The same breakpoints as style.css.
import { ref } from 'vue';

const PHONE = '(max-width: 760px)';
const NARROW = '(max-width: 1100px)';

function track(query: string) {
  const mq = window.matchMedia(query);
  const r = ref(mq.matches);
  mq.addEventListener('change', (e) => (r.value = e.matches));
  return r;
}

export const isPhone = track(PHONE); // one column, compact tables
export const isNarrow = track(NARROW); // sidebars stack above the content
