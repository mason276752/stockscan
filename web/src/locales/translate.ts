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
export function translate(locale: string, key: string, params?: Record<string, unknown> | null): string {
  const m = MESSAGES[locale] || MESSAGES.zh!;
  let s = (m[key] ?? MESSAGES.zh![key]) as Message | undefined;
  if (s == null) return key;
  if (typeof s === 'function') return s(params || {});
  if (params) {
    if (typeof params.n === 'number' && s.includes('|')) {
      const [one, many] = s.split('|') as [string, string];
      s = params.n === 1 ? one : many;
    }
    s = s.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] == null ? '' : String(params[k])));
  }
  return s;
}
