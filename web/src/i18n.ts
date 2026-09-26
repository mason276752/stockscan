// UI language: zh (繁體中文) | en. Picked once from the browser's language,
// then whatever the user chose in the header (kept in localStorage).
//
//   t(key, params)   a UI string of the current locale; "{n}" placeholders,
//                    "one|many" picks by params.n
//   tr(text)         a string the data layer produced in Chinese (indicator
//                    names, groups, units, formulas …): its English from the
//                    lookup table, itself when there is none or in zh
//   pick(obj, ...)   the field of a bilingual record for the current locale
import { computed, ref, watch } from 'vue';
import en from './locales/en.ts';
import { MESSAGES, translate } from './locales/translate.ts';
import type { DataRule } from './locales/translate.ts';

export const LOCALES: [string, string][] = [
  ['zh', '中文'],
  ['en', 'English'],
];

const browserLocale = () => ((navigator.languages?.[0] || navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
let saved: string | null = null;
try {
  saved = localStorage.getItem('stockscan.lang');
} catch {
  /* no storage */
}
export const locale = ref<string>(saved && MESSAGES[saved] ? saved : browserLocale());
export const isZh = computed(() => locale.value === 'zh');
watch(
  locale,
  (v: string) => {
    try {
      localStorage.setItem('stockscan.lang', v);
    } catch {
      /* no storage */
    }
    document.documentElement.lang = v === 'zh' ? 'zh-Hant' : 'en';
  },
  { immediate: true },
);

export const t = (key: string, params?: object | null): string => translate(locale.value, key, params);

// Chinese text from the shared computation modules (server/lib) -> English
export function tr(s: string): string;
export function tr(s: null | undefined): null | undefined;
export function tr(s: string | null | undefined): string | null | undefined;
export function tr(s: string | null | undefined): string | null | undefined {
  if (s == null || locale.value === 'zh') return s;
  const str = String(s);
  const hit = (en.data as Record<string, string>)[str];
  if (hit != null) return hit;
  for (const [re, fn] of en.dataRules as unknown as DataRule[]) {
    const m = re.exec(str);
    if (m) return fn(m);
  }
  return str;
}

// a record with both languages, e.g. SIC { zh, title } or filer status { zh, label }
// (any object: the two keys are looked up by name, so the callers need no cast)
export function pick(obj: object | null | undefined, zhKey: string, enKey: string): string {
  if (!obj) return '';
  const o = obj as Record<string, unknown>;
  return String((locale.value === 'zh' ? o[zhKey] || o[enKey] : o[enKey] || o[zhKey]) || '');
}

// number formatting locale for dates etc.
export const dateLocale = computed(() => (locale.value === 'zh' ? 'zh-TW' : 'en-US'));

// large amounts the way each language counts them: 兆 / 億 / 百萬 in Chinese,
// T / B / M in English (no currency; callers add it)
const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const f1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const f2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function bigMoney(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (locale.value === 'zh') {
    if (v >= 1e12) return `${f2.format(v / 1e12)} 兆`;
    if (v >= 1e8) return `${grouped.format(v / 1e8)} 億`;
    if (v >= 1e6) return `${grouped.format(v / 1e6)} 百萬`;
    return `${f2.format(v / 1e6)} 百萬`;
  }
  if (v >= 1e12) return `${f2.format(v / 1e12)}T`;
  if (v >= 1e9) return `${f1.format(v / 1e9)}B`;
  if (v >= 1e6) return `${grouped.format(v / 1e6)}M`;
  return `${f2.format(v / 1e6)}M`;
}
export function bigShares(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (locale.value === 'zh') return v >= 1e8 ? `${f2.format(v / 1e8)} 億股` : `${grouped.format(v / 1e6)} 百萬股`;
  return v >= 1e9 ? `${f2.format(v / 1e9)}B shares` : `${grouped.format(v / 1e6)}M shares`;
}
