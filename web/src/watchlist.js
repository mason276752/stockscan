// Watchlist kept in localStorage (per browser). Entries: { cik, ticker, name, addedAt }.
import { reactive, watch } from 'vue';

const KEY = 'stockscan.watchlist';

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && Number.isInteger(x.cik)) : [];
  } catch {
    return [];
  }
}

export const watchlist = reactive({ items: load() });

watch(
  () => watchlist.items,
  (items) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch {
      /* storage unavailable: keep it in memory */
    }
  },
  { deep: true },
);

export const isWatched = (cik) => watchlist.items.some((x) => x.cik === Number(cik));

export function toggleWatch(company) {
  const cik = Number(company.cik);
  const i = watchlist.items.findIndex((x) => x.cik === cik);
  if (i >= 0) watchlist.items.splice(i, 1);
  else watchlist.items.unshift({ cik, ticker: company.ticker || company.tickers?.[0] || null, name: company.name || '', addedAt: new Date().toISOString() });
}

export function removeWatch(cik) {
  const i = watchlist.items.findIndex((x) => x.cik === Number(cik));
  if (i >= 0) watchlist.items.splice(i, 1);
}
