// Watchlist kept in localStorage (per browser).
//   items:  [{ cik, ticker, name, addedAt, groups: [name, ...] }]
//   groups: [name, ...]   user-defined categories (e.g. 航運股), a stock may be in several
import { reactive, watch } from 'vue';

/** One watched company. `groups` are the categories the user put it in. */
export interface WatchEntry {
  cik: number;
  ticker: string | null;
  name: string;
  addedAt: string;
  groups: string[];
}

const KEY = 'stockscan.watchlist';
const KEY_GROUPS = 'stockscan.watchgroups';

function load<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export const watchlist = reactive({
  items: (Array.isArray(load<WatchEntry[]>(KEY, [])) ? load<WatchEntry[]>(KEY, []) : []).filter((x) => x && Number.isInteger(x.cik)).map((x) => ({ ...x, groups: Array.isArray(x.groups) ? x.groups : [] })) as WatchEntry[],
  groups: (Array.isArray(load<string[]>(KEY_GROUPS, [])) ? load<string[]>(KEY_GROUPS, []) : []).filter((g) => typeof g === 'string' && g.trim()) as string[],
});

const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(watchlist.items));
    localStorage.setItem(KEY_GROUPS, JSON.stringify(watchlist.groups));
  } catch {
    /* storage unavailable: keep it in memory */
  }
};
watch(() => [watchlist.items, watchlist.groups], save, { deep: true });

export const isWatched = (cik: number | string): boolean => watchlist.items.some((x) => x.cik === Number(cik));
export const entryOf = (cik: number | string): WatchEntry | null => watchlist.items.find((x) => x.cik === Number(cik)) || null;

// add (optionally straight into a group) or remove
export function toggleWatch(company: { cik: number | string; ticker?: string | null; tickers?: string[]; name?: string | null }, group: string | null = null): void {
  const cik = Number(company.cik);
  const i = watchlist.items.findIndex((x) => x.cik === cik);
  if (i >= 0 && !group) {
    watchlist.items.splice(i, 1);
    return;
  }
  if (i >= 0) {
    if (!watchlist.items[i]!.groups.includes(group!)) watchlist.items[i]!.groups.push(group!);
    return;
  }
  watchlist.items.unshift({ cik, ticker: company.ticker || company.tickers?.[0] || null, name: company.name || '', addedAt: new Date().toISOString(), groups: group ? [group] : [] });
}

export function removeWatch(cik: number | string): void {
  const i = watchlist.items.findIndex((x) => x.cik === Number(cik));
  if (i >= 0) watchlist.items.splice(i, 1);
}

export function setGroups(cik: number | string, groups: readonly string[]): void {
  const e = entryOf(cik);
  if (e) e.groups = [...new Set(groups)].filter((g) => watchlist.groups.includes(g));
}

export function addGroup(name: string | null | undefined): string | null {
  const g = String(name || '').trim();
  if (!g || watchlist.groups.includes(g)) return g || null;
  watchlist.groups.push(g);
  return g;
}

export function renameGroup(from: string, to: string | null | undefined): boolean {
  const t = String(to || '').trim();
  if (!t || t === from || watchlist.groups.includes(t)) return false;
  watchlist.groups.splice(watchlist.groups.indexOf(from), 1, t);
  for (const e of watchlist.items) e.groups = e.groups.map((g) => (g === from ? t : g));
  return true;
}

export function removeGroup(name: string): void {
  const i = watchlist.groups.indexOf(name);
  if (i < 0) return;
  watchlist.groups.splice(i, 1);
  for (const e of watchlist.items) e.groups = e.groups.filter((g) => g !== name);
}
