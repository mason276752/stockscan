// The UI strings looked up by locale, without the reactive locale of
// i18n.ts: the data-layer worker (api.static.worker.ts) has no Vue and no
// DOM, so it translates with the locale the page sends along each request.
import zh from './zh.ts';
import en from './en.ts';

/** A message: a template, or a function of the parameters. */
export type Message = string | ((p: Record<string, unknown>) => string);
/**
 * One locale's strings. Two keys are not messages: `data` is the lookup
 * table for the Chinese strings server/lib produces, and `dataRules` the
 * patterned ones (i18n.ts `tr`).
 */
export type Messages = Record<string, Message | Record<string, string> | DataRule[]>;

/** A patterned data string: the regex, and what it becomes in English. */
export type DataRule = [RegExp, (m: RegExpExecArray) => string];

export const MESSAGES: Record<string, Messages> = { zh, en };

// t(key, params) of i18n.ts for an explicit locale: "{n}" placeholders,
// "one|many" picks by params.n, a function entry is called with params
// `params` is any object - the placeholders are looked up by name, so a
// caller can hand over a typed record (a note, a basket warning) unchanged
export function translate(locale: string, key: string, params?: object | null): string {
  const m = MESSAGES[locale] || MESSAGES.zh!;
  let s = (m[key] ?? MESSAGES.zh![key]) as Message | undefined;
  if (s == null) return key;
  const p = (params || null) as Record<string, unknown> | null;
  if (typeof s === 'function') return s(p || {});
  if (p) {
    if (typeof p.n === 'number' && s.includes('|')) {
      const [one, many] = s.split('|') as [string, string];
      s = p.n === 1 ? one : many;
    }
    s = s.replace(/\{(\w+)\}/g, (_, k: string) => (p[k] == null ? '' : String(p[k])));
  }
  return s;
}
