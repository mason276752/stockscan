// Custom ETFs ("baskets") kept in localStorage (per browser).
//   [{ id, name, createdAt, rebalance: 'none' | 'daily', prune, constituents: [{ ticker, cik, name, weight }] }]
// prune: drop delisted names as soon as the first price data shows which
// ones they are (set when a basket is copied from an ETF / screener / list)
// weight is a percentage (the page keeps them summing to 100; 0 leaves the
// stock out of the index while keeping it in the list)
import { reactive, watch } from 'vue';

const KEY = 'stockscan.baskets';
const KEY_CURRENT = 'stockscan.basket';

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

const round2 = (v) => Math.round(v * 100) / 100;

// scale the weights so they add up to 100 (equal weights when they are all zero)
export function normalizeWeights(constituents) {
  const sum = constituents.reduce((s, c) => s + (Number(c.weight) > 0 ? Number(c.weight) : 0), 0);
  for (const c of constituents) c.weight = sum > 0 ? round2(((Number(c.weight) > 0 ? Number(c.weight) : 0) / sum) * 100) : round2(100 / constituents.length);
  return constituents;
}

const clean = (b) => {
  const constituents = (Array.isArray(b.constituents) ? b.constituents : [])
    .filter((c) => c && c.ticker)
    .map((c) => ({ ticker: String(c.ticker).toUpperCase(), cik: c.cik ?? null, name: c.name || '', weight: Number(c.weight) > 0 ? Number(c.weight) : 0 }));
  // relative weights (every one "1": new baskets, and those saved before weights were percentages) -> percentages
  if (constituents.length && constituents.every((c) => c.weight === 1)) normalizeWeights(constituents);
  return { id: String(b.id || newId()), name: String(b.name || '自製 ETF'), createdAt: b.createdAt || new Date().toISOString(), rebalance: b.rebalance === 'daily' ? 'daily' : 'none', prune: !!b.prune, constituents };
};

export const baskets = reactive({
  items: (Array.isArray(load(KEY, [])) ? load(KEY, []) : []).map(clean),
  current: load(KEY_CURRENT, null),
});

watch(
  () => [baskets.items, baskets.current],
  () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(baskets.items));
      localStorage.setItem(KEY_CURRENT, JSON.stringify(baskets.current));
    } catch {
      /* storage unavailable: keep it in memory */
    }
  },
  { deep: true },
);

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const basketOf = (id) => baskets.items.find((b) => b.id === id) || null;

// Create a basket from a list of companies (their `weight` when given, else equal) and make it current.
export function createBasket(name, companies = [], { rebalance = 'none', prune = false } = {}) {
  const b = clean({ id: newId(), name, rebalance, prune, constituents: companies.map((c) => ({ ticker: c.ticker || c.tickers?.[0], cik: c.cik, name: c.name, weight: Number(c.weight) > 0 ? Number(c.weight) : 1 })) });
  baskets.items.unshift(b);
  baskets.current = b.id;
  return b;
}

export function removeBasket(id) {
  const i = baskets.items.findIndex((b) => b.id === id);
  if (i >= 0) baskets.items.splice(i, 1);
  if (baskets.current === id) baskets.current = baskets.items[0]?.id ?? null;
}

// add (or ignore when already in) a constituent; it takes an equal share and
// the others shrink proportionally so the total stays 100
export function addConstituent(id, company) {
  const b = basketOf(id);
  const ticker = String(company.ticker || company.tickers?.[0] || '').toUpperCase();
  if (!b || !ticker) return false;
  if (b.constituents.some((c) => c.ticker === ticker)) return false;
  const n = b.constituents.length + 1;
  for (const c of b.constituents) c.weight = round2(c.weight * (1 - 1 / n));
  b.constituents.push({ ticker, cik: company.cik ?? null, name: company.name || '', weight: round2(100 / n) });
  return true;
}

export function removeConstituent(id, ticker) {
  removeConstituents(id, [ticker]);
}

// remove several at once; the rest are rescaled to 100 in proportion
export function removeConstituents(id, tickers) {
  const b = basketOf(id);
  if (!b) return 0;
  const drop = new Set(tickers);
  const before = b.constituents.length;
  b.constituents = b.constituents.filter((c) => !drop.has(c.ticker));
  if (b.constituents.length && b.constituents.length < before) normalizeWeights(b.constituents);
  return before - b.constituents.length;
}

export function equalWeights(id) {
  const b = basketOf(id);
  if (b) for (const c of b.constituents) c.weight = round2(100 / b.constituents.length);
}
