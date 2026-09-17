// Custom ETFs ("baskets") kept in localStorage (per browser).
//   [{ id, name, createdAt, rebalance: 'none' | 'daily', prune, source, sync, excluded,
//      constituents: [{ ticker, cik, name, weight, origin, manualWeight, sourceWeight, gone }] }]
// weight is a percentage (the page keeps them summing to 100; 0 leaves the
// stock out of the index while keeping it in the list).
// prune: drop delisted names as soon as the first price data shows which
// ones they are (set when a basket is copied from an ETF / screener / list).
// source: where the basket was copied from and can be resynced from -
//   { type: 'etf', ticker } | { type: 'screen', params, n, label } | { type: 'watch', group } | null
// sync: { at, asOf, sourceName, added, removed, changed } of the last resync.
// excluded: source names the user removed, [{ ticker, name, cik, sourceWeight, at }] (a resync will not bring them back).
// per constituent: origin 'source' (came from the source) | 'manual' (added by hand);
//   manualWeight = the user typed a weight (a resync leaves it alone; sourceWeight
//   keeps the source's figure so it can be restored); gone = the source no longer
//   lists it but it is kept because of a manual weight.
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

const cleanRow = (c) => ({
  ticker: String(c.ticker).toUpperCase(),
  cik: c.cik ?? null,
  name: c.name || '',
  weight: Number(c.weight) > 0 ? Number(c.weight) : 0,
  origin: c.origin === 'source' ? 'source' : 'manual',
  manualWeight: !!c.manualWeight,
  sourceWeight: Number(c.sourceWeight) > 0 ? Number(c.sourceWeight) : null,
  gone: !!c.gone,
});

const clean = (b) => {
  const constituents = (Array.isArray(b.constituents) ? b.constituents : []).filter((c) => c && c.ticker).map(cleanRow);
  // relative weights (every one "1": new baskets, and those saved before weights were percentages) -> percentages
  if (constituents.length && constituents.every((c) => c.weight === 1)) normalizeWeights(constituents);
  return {
    id: String(b.id || newId()),
    name: String(b.name || 'ETF'),
    createdAt: b.createdAt || new Date().toISOString(),
    rebalance: b.rebalance === 'daily' ? 'daily' : 'none',
    prune: !!b.prune,
    source: b.source && typeof b.source === 'object' && b.source.type ? b.source : null,
    sync: b.sync && typeof b.sync === 'object' ? b.sync : null,
    excluded: Array.isArray(b.excluded) ? b.excluded.filter(Boolean).map((e) => (typeof e === 'string' ? { ticker: e.toUpperCase(), name: '', cik: null, sourceWeight: null, at: null } : { ticker: String(e.ticker).toUpperCase(), name: e.name || '', cik: e.cik ?? null, sourceWeight: e.sourceWeight ?? null, at: e.at || null })) : [],
    constituents,
  };
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

// Create a basket from a list of companies (their `weight` when given, else
// equal) and make it current. With a `source` the rows are marked as coming
// from it, so they can be resynced later.
export function createBasket(name, companies = [], { rebalance = 'none', prune = false, source = null, sync = null } = {}) {
  const b = clean({
    id: newId(),
    name,
    rebalance,
    prune,
    source,
    sync,
    constituents: companies.map((c) => {
      const w = Number(c.weight) > 0 ? Number(c.weight) : 1;
      return { ticker: c.ticker || c.tickers?.[0], cik: c.cik, name: c.name, weight: w, origin: source ? 'source' : 'manual', sourceWeight: source ? w : null };
    }),
  });
  if (source) normalizeWeights(b.constituents);
  for (const c of b.constituents) if (source) c.sourceWeight = c.weight;
  baskets.items.unshift(b);
  baskets.current = b.id;
  return b;
}

// Bring a basket up to date with its source's current list, keeping what the
// user did by hand: rows added by hand and weights typed by hand stay; a
// source row the source dropped is removed unless its weight was typed (then
// it is kept and flagged `gone`); rows the user removed (excluded) are not
// re-added; the untouched source rows share whatever the fixed rows leave.
// `holdings`: [{ ticker, cik, name, weight }] (weights in any scale).
export function applySource(basket, holdings, { sourceName = '', asOf = null } = {}) {
  const b = basket;
  const incoming = new Map();
  const excluded = new Set((b.excluded || []).map((e) => e.ticker));
  const tot = holdings.reduce((s, h) => s + (Number(h.weight) > 0 ? Number(h.weight) : 0), 0) || holdings.length;
  for (const h of holdings) {
    const t = String(h.ticker || h.symbol || '').toUpperCase();
    if (!t || incoming.has(t)) continue;
    if (excluded.has(t)) {
      // keep the excluded entry's name / weight current for the table
      const e = b.excluded.find((x) => x.ticker === t);
      e.sourceWeight = round2(((Number(h.weight) > 0 ? Number(h.weight) : tot / holdings.length) / tot) * 100);
      if (!e.name) e.name = h.name || '';
      e.cik ??= h.cik ?? null;
      continue;
    }
    incoming.set(t, { ticker: t, cik: h.cik ?? null, name: h.name || '', weight: round2(((Number(h.weight) > 0 ? Number(h.weight) : tot / holdings.length) / tot) * 100) });
  }
  const added = [];
  const removed = [];
  let changed = 0;
  const keep = [];
  for (const c of b.constituents) {
    const inc = incoming.get(c.ticker);
    if (c.origin === 'manual') {
      if (inc) {
        // the source now lists a name the user had added: it becomes a source row, weight kept as typed
        Object.assign(c, { origin: 'source', manualWeight: true, sourceWeight: inc.weight, gone: false, cik: c.cik ?? inc.cik, name: c.name || inc.name });
        incoming.delete(c.ticker);
      }
      keep.push(c);
      continue;
    }
    if (inc) {
      if (c.sourceWeight !== inc.weight) changed++;
      c.sourceWeight = inc.weight;
      if (!c.manualWeight) c.weight = inc.weight;
      c.gone = false;
      c.cik = c.cik ?? inc.cik;
      if (!c.name) c.name = inc.name;
      incoming.delete(c.ticker);
      keep.push(c);
    } else if (c.manualWeight) {
      c.gone = true;
      keep.push(c);
    } else removed.push(c.ticker);
  }
  for (const inc of incoming.values()) {
    keep.push(cleanRow({ ...inc, origin: 'source', sourceWeight: inc.weight }));
    added.push(inc.ticker);
  }
  b.constituents = keep;
  fitWeights(b);
  b.sync = { at: new Date().toISOString(), asOf, sourceName, added, removed, changed };
  return b.sync;
}

// Untouched source rows are scaled to fill what the hand-set rows (manual
// additions, typed weights, kept-but-gone rows) leave of 100.
export function fitWeights(b) {
  const fixed = b.constituents.filter((c) => c.origin === 'manual' || c.manualWeight || c.gone);
  const free = b.constituents.filter((c) => !fixed.includes(c));
  const fixedSum = fixed.reduce((s, c) => s + (Number(c.weight) > 0 ? Number(c.weight) : 0), 0);
  const freeSum = free.reduce((s, c) => s + (Number(c.sourceWeight ?? c.weight) > 0 ? Number(c.sourceWeight ?? c.weight) : 0), 0);
  if (!free.length || !freeSum) return;
  const room = Math.max(0, 100 - fixedSum);
  for (const c of free) c.weight = round2(((Number(c.sourceWeight ?? c.weight) > 0 ? Number(c.sourceWeight ?? c.weight) : 0) / freeSum) * room);
}

// The user typed a weight: from now on resyncs leave this row alone.
export function setManualWeight(id, ticker, weight) {
  const b = basketOf(id);
  const c = b?.constituents.find((x) => x.ticker === ticker);
  if (!c) return;
  c.weight = Number(weight) >= 0 ? Number(weight) : 0;
  if (c.origin === 'source') c.manualWeight = c.sourceWeight == null || Math.abs(c.weight - c.sourceWeight) > 0.005;
}

// Back to the source's weight (and back under the source's control).
export function revertWeight(id, ticker) {
  const b = basketOf(id);
  const c = b?.constituents.find((x) => x.ticker === ticker);
  if (!c || c.origin !== 'source') return;
  c.manualWeight = false;
  if (c.gone) {
    b.constituents.splice(b.constituents.indexOf(c), 1);
  } else if (c.sourceWeight != null) c.weight = c.sourceWeight;
  fitWeights(b);
}

// Forget an exclusion (or all of them) so the next resync brings the name back.
export function restoreExcluded(id, ticker = null) {
  const b = basketOf(id);
  if (!b) return;
  b.excluded = ticker ? b.excluded.filter((e) => e.ticker !== ticker) : [];
}

export function removeBasket(id) {
  const i = baskets.items.findIndex((b) => b.id === id);
  if (i >= 0) baskets.items.splice(i, 1);
  if (baskets.current === id) baskets.current = baskets.items[0]?.id ?? null;
}

// add (or ignore when already in) a constituent by hand; it takes an equal
// share and the others shrink proportionally so the total stays 100
export function addConstituent(id, company) {
  const b = basketOf(id);
  const ticker = String(company.ticker || company.tickers?.[0] || '').toUpperCase();
  if (!b || !ticker) return false;
  if (b.constituents.some((c) => c.ticker === ticker)) return false;
  const n = b.constituents.length + 1;
  for (const c of b.constituents) c.weight = round2(c.weight * (1 - 1 / n));
  b.constituents.push(cleanRow({ ticker, cik: company.cik ?? null, name: company.name || '', weight: round2(100 / n), origin: 'manual' }));
  b.excluded = (b.excluded || []).filter((e) => e.ticker !== ticker);
  return true;
}

export function removeConstituent(id, ticker) {
  removeConstituents(id, [ticker]);
}

// remove several at once; the rest are rescaled to 100 in proportion. Source
// rows go on the excluded list so a resync does not bring them back.
// the basket's source changed (screener filters edited): remember the new
// filters and name; the caller applies the new list with applySource
export function setSource(id, source, name = null) {
  const b = basketOf(id);
  if (!b) return null;
  b.source = source;
  if (name) b.name = name;
  return b;
}

// the company trades under a new ticker (EDGAR moved the CIK): follow it
export function renameConstituent(id, from, to) {
  const b = basketOf(id);
  const c = b?.constituents.find((x) => x.ticker === from);
  if (!c || !to || b.constituents.some((x) => x.ticker === to)) return false;
  c.ticker = String(to).toUpperCase();
  return true;
}

export function removeConstituents(id, tickers) {
  const b = basketOf(id);
  if (!b) return 0;
  const drop = new Set(tickers);
  const before = b.constituents.length;
  for (const c of b.constituents) {
    if (drop.has(c.ticker) && c.origin === 'source' && !b.excluded.some((e) => e.ticker === c.ticker)) b.excluded.push({ ticker: c.ticker, name: c.name, cik: c.cik, sourceWeight: c.sourceWeight, at: new Date().toISOString() });
  }
  b.constituents = b.constituents.filter((c) => !drop.has(c.ticker));
  if (b.constituents.length && b.constituents.length < before) normalizeWeights(b.constituents);
  return before - b.constituents.length;
}

// every row the same weight - typed weights for all of them, as far as a resync is concerned
export function equalWeights(id) {
  const b = basketOf(id);
  if (!b) return;
  for (const c of b.constituents) {
    c.weight = round2(100 / b.constituents.length);
    if (c.origin === 'source') c.manualWeight = c.sourceWeight == null || Math.abs(c.weight - c.sourceWeight) > 0.005;
  }
}
