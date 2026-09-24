// What the two index endpoints answer with, as the pages read them:
// POST /api/basket (a hand-picked custom ETF) and POST /api/basket/rule (the
// screener's filters replayed through history). One shape covers both - the
// rule fields are simply absent on a hand-picked basket.

import type {
  BasketBar, BasketConstituent, BasketNote, BasketStats, IsoDate, RuleConstituent, RuleEvent, RuleMember,
} from '../../server/lib/types.ts';

/** A constituent that no price source could answer for. */
export interface FailedMember {
  ticker: string;
  error?: string | null;
  listed?: boolean;
  renamed?: string;
}

/** The benchmark line, rebased to the index's own starting level. */
export interface BenchmarkLine {
  symbol: string;
  source?: string | null;
  startClose: number | null;
  points: { time: IsoDate; value: number }[];
}

/**
 * One name of the index. A hand-picked basket and a rule ETF report
 * different things about a constituent (weights and closes against spells
 * and days held), so which fields are set depends on which kind it is.
 */
export type IndexConstituent = Partial<BasketConstituent> & Partial<RuleConstituent> & { symbol: string };

/** The index itself, plus everything the pages show around it. */
export interface IndexResult {
  bars: BasketBar[];
  start: IsoDate | null;
  end: IsoDate | null;
  notes: BasketNote[];
  constituents: IndexConstituent[];
  stats: BasketStats | null;
  failed?: FailedMember[];
  benchmark?: BenchmarkLine | null;
  /** which price sources the bars came from */
  source?: string | null;
  /** whether TWS / TradingView were connected when it was built */
  ib?: boolean;
  tv?: boolean;
  window?: { from: IsoDate | null; to: IsoDate | null };

  // ---- a rule ETF only ----
  rule?: boolean;
  members?: RuleMember[];
  events?: RuleEvent[];
  /** { date, n } whenever the number of holdings changed */
  counts?: { date: IsoDate; n: number; special?: true }[];
  /** conditions the replay could not answer (the market snapshot is today's) */
  skipped?: string[];
  tested?: number;
  holding?: number;
  rebalances?: number | null;
  specials?: number;
  minPrice?: number;

  [key: string]: unknown;
}
