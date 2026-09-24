// Colour theme: auto (the system setting) | light | dark, chosen in the
// header and kept in localStorage. index.html applies the saved choice
// before the first paint (the same rule as here, inlined); this module keeps
// <html data-theme> right when the choice or the system setting changes and
// tells the charts (which draw their own colours) which side they are on.
import { computed, ref, watch } from 'vue';

/** What the header offers: follow the system, or pin one. */
export type Theme = 'auto' | 'light' | 'dark';

export const THEMES: Theme[] = ['auto', 'light', 'dark'];
const KEY = 'stockscan.theme';
let saved: string | null = null;
try {
  saved = localStorage.getItem(KEY);
} catch {
  /* no storage */
}
export const theme = ref<Theme>(THEMES.includes(saved as Theme) ? (saved as Theme) : 'auto');

const media = window.matchMedia('(prefers-color-scheme: dark)');
const systemDark = ref(media.matches);
media.addEventListener('change', (e) => (systemDark.value = e.matches));

export const isDark = computed(() => theme.value === 'dark' || (theme.value === 'auto' && systemDark.value));

watch(
  [theme, isDark],
  ([t, dark]) => {
    try {
      if (t === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* no storage */
    }
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  },
  { immediate: true },
);

// a colour token's current value, for the charts
export const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
