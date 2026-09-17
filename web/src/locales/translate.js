// The UI strings looked up by locale, without the reactive locale of
// i18n.js: the data-layer worker (api.static.worker.js) has no Vue and no
// DOM, so it translates with the locale the page sends along each request.
import zh from './zh.js';
import en from './en.js';

export const MESSAGES = { zh, en };

// t(key, params) of i18n.js for an explicit locale: "{n}" placeholders,
// "one|many" picks by params.n, a function entry is called with params
export function translate(locale, key, params) {
  const m = MESSAGES[locale] || MESSAGES.zh;
  let s = m[key] ?? MESSAGES.zh[key];
  if (s == null) return key;
  if (typeof s === 'function') return s(params || {});
  if (params) {
    if (typeof params.n === 'number' && s.includes('|')) {
      const [one, many] = s.split('|');
      s = params.n === 1 ? one : many;
    }
    s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] == null ? '' : String(params[k])));
  }
  return s;
}
