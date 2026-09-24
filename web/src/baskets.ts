// Custom ETFs ("baskets") kept in localStorage (per browser).
//   [{ id, name, createdAt, mode, rebalance: 'none' | 'daily', prune, source, sync, excluded,
//      constituents: [{ ticker, cik, name, weight, origin, manualWeight, sourceWeight, gone }] }]
// mode 'manual' (the default): the list below is the ETF, and the user owns
// it - add, remove, weigh as they like.
// mode 'rule': there is no list. The ETF is a set of screener filters
// (`source.params`) replayed through history - it holds, at equal weight,
// whoever passes them on the day, and every change comes from a filing
// (server/lib/ruleEtf.js). `constituents` stays empty and nothing about the
// holdings can be edited; editing the filters is editing the ETF.
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
import type { ScreenQueryParams } from '../../server/lib/types.ts';

/**
 * Where a basket was copied from, and can be resynced from: an ETF's
 * holdings, a screen (or the filters themselves, `rule`), or a watchlist
 * group. `type` says which of the rest are set.
 */
export interface BasketSource {
  type: 'etf' | 'screen' | 'rule' | 'watch' | string;
  /** type 'etf' */
  ticker?: string;
  /** type 'watch' */
  group?: string;
  /** type 'screen' / 'rule': the query, and the URL form the page reopens */
  params?: ScreenQueryParams;
  url?: Record<string, string | undefined>;
  /** how many of the results were taken (null = all of them) */
  n?: number | null;
  /** the filters as the screener words them, used as the default name */
  label?: string;
}

/** What the last resync did. */
export interface BasketSync {
  at: string;
  asOf: string | null;
  sourceName: string;
  added: string[];
  removed: string[];
  changed: number;
}

/** A source name the user took out; a resync will not bring it back. */
export interface ExcludedRow {
  ticker: string;
  name: string;
  cik: number | null;
  sourceWeight: number | null;
  at: string | null;
}

/** One holding. `weight` is a percentage; 0 leaves it out of the index. */
export interface Constituent {
  ticker: string;
  cik: number | null;
  name: string;
  weight: number;
  /** came from the source, or was added by hand */
  origin: 'source' | 'manual';
  /** the user typed this weight: a resync leaves it alone */
  manualWeight: boolean;
  /** what the source says it should be, so it can be restored */
  sourceWeight: number | null;
  /** the source no longer lists it, but a typed weight keeps it */
  gone: boolean;
}

/** A custom ETF as it is kept in localStorage. */
export interface Basket {
  id: string;
  name: string;
  createdAt: string;
  /** 'rule': the filters are the fund, and `constituents` stays empty */
  mode: 'manual' | 'rule';
  rebalance: 'none' | 'daily';
  /** drop delisted names as soon as the prices say which they are */
  prune: boolean;
  source: BasketSource | null;
  sync: BasketSync | null;
  excluded: ExcludedRow[];
  constituents: Constituent[];
}

/** One line of a source's holdings, in whatever scale it uses. */
export interface SourceHolding {
  ticker?: string;
  symbol?: string;
  cik?: number | null;
  name?: string;
  weight?: number | null;
}

const KEY = 'stockscan.baskets';
const KEY_CURRENT = 'stockscan.basket';

function load<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// scale the weights so they add up to 100 (equal weights when they are all zero)
export function normalizeWeights(constituents: Constituent[]): Constituent[] {
  const sum = constituents.reduce((s, c) => s + (Number(c.weight) > 0 ? Number(c.weight) : 0), 0);
  for (const c of constituents) c.weight = sum > 0 ? round2(((Number(c.weight) > 0 ? Number(c.weight) : 0) / sum) * 100) : round2(100 / constituents.length);
  return constituents;
}

const cleanRow = (c: Partial<Constituent> & { ticker: string }): Constituent => ({
  ticker: String(c.ticker).toUpperCase(),
  cik: c.cik ?? null,
  name: c.name || '',
  weight: Number(c.weight) > 0 ? Number(c.weight) : 0,
  origin: c.origin === 'source' ? ('source' as const) : ('manual' as const),
  manualWeight: !!c.manualWeight,
  sourceWeight: Number(c.sourceWeight) > 0 ? Number(c.sourceWeight) : null,
  gone: !!c.gone,
});

const clean = (b: Partial<Basket>): Basket => {
  const constituents = ((Array.isArray(b.constituents) ? b.constituents : []) as Constituent[]).filter((c) => c && c.ticker).map(cleanRow);
  // relative weights (every one "1": new baskets, and those saved before weights were percentages) -> percentages
  if (constituents.length && constituents.every((c) => c.weight === 1)) normalizeWeights(constituents);
  return {
    id: String(b.id || newId()),
    name: String(b.name || 'ETF'),
    createdAt: b.createdAt || new Date().toISOString(),
    mode: b.mode === 'rule' ? ('rule' as const) : ('manual' as const),
    rebalance: b.rebalance === 'daily' ? ('daily' as const) : ('none' as const),
    prune: !!b.prune,
    source: b.source && typeof b.source === 'object' && b.source.type ? b.source : null,
    sync: b.sync && typeof b.sync === 'object' ? b.sync : null,
    excluded: Array.isArray(b.excluded) ? (b.excluded as (string | ExcludedRow)[]).filter(Boolean).map((e) => (typeof e === 'string' ? { ticker: e.toUpperCase(), name: '', cik: null, sourceWeight: null, at: null } : { ticker: String(e.ticker).toUpperCase(), name: e.name || '', cik: e.cik ?? null, sourceWeight: e.sourceWeight ?? null, at: e.at || null })) : [],
    constituents,
  };
};

export const baskets = reactive({
  items: ((Array.isArray(load<Basket[]>(KEY, [])) ? load<Basket[]>(KEY, []) : []) as Basket[]).map((b) => clean(b)),
  current: load<string | null>(KEY_CURRENT, null),
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
export const basketOf = (id: string | null | undefined): Basket | null => baskets.items.find((b) => b.id === id) || null;

// Create a basket from a list of companies (their `weight` when given, else
// equal) and make it current. With a `source` the rows are marked as coming
// from it, so they can be resynced later.
/** How a new basket is set up. */
export interface CreateBasketOptions {
  rebalance?: 'none' | 'daily';
  prune?: boolean;
  source?: BasketSource | null;
  sync?: BasketSync | null;
}

/** A company as the pages hand it to createBasket. */
export interface BasketCandidate {
  ticker?: string | null;
  tickers?: string[];
  cik?: number | null;
  name?: string | null;
  weight?: number | null;
}

export function createBasket(name: string, companies: readonly BasketCandidate[] = [], { rebalance = 'none', prune = false, source = null, sync = null }: CreateBasketOptions = {}): Basket {
  const b = clean({
    id: newId(),
    name,
    rebalance,
    prune,
    source,
    sync,
    constituents: companies.map((c): Constituent => {
      const w = Number(c.weight) > 0 ? Number(c.weight) : 1;
      return { ticker: (c.ticker || c.tickers?.[0])!, cik: c.cik ?? null, name: c.name ?? '', weight: w, origin: source ? 'source' : 'manual', manualWeight: false, sourceWeight: source ? w : null, gone: false };
    }),
  });
  if (source) normalizeWeights(b.constituents);
  for (const c of b.constituents) if (source) c.sourceWeight = c.weight;
  baskets.items.unshift(b);
  baskets.current = b.id;
  return b;
}

// A rule ETF: the filters are the fund. Nothing is held yet - what it holds
// on any day comes out of the replay, so there is no constituent list to
// create and none to keep in step.
export function createRuleBasket(name: string, source: BasketSource): Basket {
  const b = clean({ id: newId(), name, mode: 'rule', source, constituents: [] });
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
export function applySource(basket: Basket, holdings: readonly SourceHolding[], { sourceName = '', asOf = null }: { sourceName?: string; asOf?: string | null } = {}): BasketSync {
  const b = basket;
  const incoming = new Map<string, { ticker: string; cik: number | null; name: string; weight: number }>();
  const excluded = new Set((b.excluded || []).map((e) => e.ticker));
  const tot = holdings.reduce((s, h) => s + (Number(h.weight) > 0 ? Number(h.weight) : 0), 0) || holdings.length;
  for (const h of holdings) {
    const t = String(h.ticker || h.symbol || '').toUpperCase();
    if (!t || incoming.has(t)) continue;
    if (excluded.has(t)) {
      // keep the excluded entry's name / weight current for the table
      const e = b.excluded.find((x) => x.ticker === t)!;
      e.sourceWeight = round2(((Number(h.weight) > 0 ? Number(h.weight) : tot / holdings.length) / tot) * 100);
      if (!e.name) e.name = h.name || '';
      e.cik ??= h.cik ?? null;
      continue;
    }
    incoming.set(t, { ticker: t, cik: h.cik ?? null, name: h.name || '', weight: round2(((Number(h.weight) > 0 ? Number(h.weight) : tot / holdings.length) / tot) * 100) });
  }
  const added: string[] = [];
  const removed: string[] = [];
  let changed = 0;
  const keep: Constituent[] = [];
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
export function fitWeights(b: Basket): void {
  const fixed = b.constituents.filter((c) => c.origin === 'manual' || c.manualWeight || c.gone);
  const free = b.constituents.filter((c) => !fixed.includes(c));
  const fixedSum = fixed.reduce((s, c) => s + (Number(c.weight) > 0 ? Number(c.weight) : 0), 0);
  const freeSum = free.reduce((s, c) => s + (Number(c.sourceWeight ?? c.weight) > 0 ? Number(c.sourceWeight ?? c.weight) : 0), 0);
  if (!free.length || !freeSum) return;
  const room = Math.max(0, 100 - fixedSum);
  for (const c of free) c.weight = round2(((Number(c.sourceWeight ?? c.weight) > 0 ? Number(c.sourceWeight ?? c.weight) : 0) / freeSum) * room);
}

// The user typed a weight: from now on resyncs leave this row alone.
export function setManualWeight(id: string, ticker: string, weight: number | string): void {
  const b = basketOf(id);
  const c = b?.constituents.find((x) => x.ticker === ticker);
  if (!c) return;
  c.weight = Number(weight) >= 0 ? Number(weight) : 0;
  if (c.origin === 'source') c.manualWeight = c.sourceWeight == null || Math.abs(c.weight - c.sourceWeight) > 0.005;
}

// Back to the source's weight (and back under the source's control).
export function revertWeight(id: string, ticker: string): void {
  const b = basketOf(id);
  const c = b?.constituents.find((x) => x.ticker === ticker);
  if (!c || c.origin !== 'source') return;
  c.manualWeight = false;
  if (c.gone) {
    b!.constituents.splice(b!.constituents.indexOf(c), 1);
  } else if (c.sourceWeight != null) c.weight = c.sourceWeight;
  fitWeights(b!);
}

// Forget an exclusion (or all of them) so the next resync brings the name back.
export function restoreExcluded(id: string, ticker: string | null = null): void {
  const b = basketOf(id);
  if (!b) return;
  b.excluded = ticker ? b.excluded.filter((e) => e.ticker !== ticker) : [];
}

export function removeBasket(id: string): void {
  const i = baskets.items.findIndex((b) => b.id === id);
  if (i >= 0) baskets.items.splice(i, 1);
  if (baskets.current === id) baskets.current = baskets.items[0]?.id ?? null;
}

// add (or ignore when already in) a constituent by hand; it takes an equal
// share and the others shrink proportionally so the total stays 100
export function addConstituent(id: string, company: BasketCandidate): boolean {
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

export function removeConstituent(id: string, ticker: string): void {
  removeConstituents(id, [ticker]);
}

// remove several at once; the rest are rescaled to 100 in proportion. Source
// rows go on the excluded list so a resync does not bring them back.
// the basket's source changed (screener filters edited): remember the new
// filters and name; the caller applies the new list with applySource
export function setSource(id: string, source: BasketSource | null, name: string | null = null): Basket | null {
  const b = basketOf(id);
  if (!b) return null;
  b.source = source;
  if (name) b.name = name;
  return b;
}

// the company trades under a new ticker (EDGAR moved the CIK): follow it
export function renameConstituent(id: string, from: string, to: string | null | undefined): boolean {
  const b = basketOf(id);
  const c = b?.constituents.find((x) => x.ticker === from);
  if (!c || !to || b!.constituents.some((x) => x.ticker === to)) return false;
  c.ticker = String(to).toUpperCase();
  return true;
}

export function removeConstituents(id: string, tickers: readonly string[]): number {
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
export function equalWeights(id: string): void {
  const b = basketOf(id);
  if (!b) return;
  for (const c of b.constituents) {
    c.weight = round2(100 / b.constituents.length);
    if (c.origin === 'source') c.manualWeight = c.sourceWeight == null || Math.abs(c.weight - c.sourceWeight) > 0.005;
  }
}
