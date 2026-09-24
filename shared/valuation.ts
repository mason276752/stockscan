// Valuation models - pure functions shared by the server (defaults) and the
// browser (the assumptions are editable on the page). All money per share.
//
// inputs: { eps, bvps, dps, fcfps, ocfps, ebitps, daps, capexps, cashps, debtps,
//           tbvps, roe, payout, taxRate }   (null when unknown)
// a:      { r, g1, gT, years, taxRate, aaaYield, gGraham }
//   r        discount rate (required return), e.g. 0.09
//   g1       growth for the first `years` years
//   gT       perpetual growth after that (must be < r)
//   aaaYield current AAA corporate bond yield in % for Graham's formula (e.g. 4.5)

/** Per-share figures a model reads. Any of them may be unknown. */
export interface ValuationInputs {
  eps?: number | null;
  bvps?: number | null;
  dps?: number | null;
  fcfps?: number | null;
  ocfps?: number | null;
  ebitps?: number | null;
  daps?: number | null;
  capexps?: number | null;
  cashps?: number | null;
  debtps?: number | null;
  tbvps?: number | null;
  roe?: number | null;
  payout?: number | null;
  taxRate?: number | null;
}

/** The assumptions the page lets the reader change. */
export interface ValuationAssumptions {
  /** discount rate (required return), e.g. 0.09 */
  r: number;
  /** growth for the first `years` years */
  g1: number;
  /** perpetual growth after that (must be < r) */
  gT: number;
  years: number;
  taxRate?: number | null;
  /** current AAA corporate bond yield in %, for Graham's formula */
  aaaYield?: number | null;
  gGraham?: number | null;
}

/** One valuation model: what it is, and how it prices a share. */
export interface ValuationModel {
  key: string;
  name: string;
  formula: string;
  calc: (i: ValuationInputs, a: ValuationAssumptions) => number | null;
}

const ok = (...xs: unknown[]): boolean => xs.every((x) => typeof x === 'number' && Number.isFinite(x));

// Two-stage discounted cash flow of one per-share stream.
function twoStage(base: number | null | undefined, { r, g1, gT, years }: ValuationAssumptions): number | null {
  if (!ok(base, r, g1, gT, years) || r <= gT) return null;
  let pv = 0;
  let cf = base!;
  for (let t = 1; t <= years; t++) {
    cf *= 1 + g1;
    pv += cf / (1 + r) ** t;
  }
  const terminal = (cf * (1 + gT)) / (r - gT);
  return pv + terminal / (1 + r) ** years;
}

export const MODELS: ValuationModel[] = [
  {
    key: 'dcf',
    name: '自由現金流折現 DCF',
    formula: '自由現金流（營業現金流量 − 資本支出）以 g1 成長 N 年、之後以 gT 永續成長，用 r 折現；加淨現金（現金 − 有息負債）後除以股數',
    calc: (i, a) => {
      const pv = twoStage(i.fcfps, a);
      return pv == null ? null : pv + (i.cashps ?? 0) - (i.debtps ?? 0);
    },
  },
  {
    key: 'ddm',
    name: '股利折現 DDM（兩階段）',
    formula: '每股股利以 g1 成長 N 年、之後以 gT 永續成長，用 r 折現（Gordon 模型的兩階段版）。不配息的公司不適用',
    calc: (i, a) => (i.dps! > 0 ? twoStage(i.dps, a) : null),
  },
  {
    key: 'rim',
    name: '剩餘收益模型 RIM',
    formula: '每股淨值 + 未來剩餘收益（EPS − r × 期初每股淨值）的現值；EPS 以 g1 成長 N 年，淨值每年加上保留盈餘（EPS × (1 − 配息率)），之後剩餘收益以 gT 永續成長',
    calc: (i, a) => {
      if (!ok(i.eps, i.bvps, a.r, a.g1, a.gT, a.years) || a.r <= a.gT) return null;
      const payout = ok(i.payout) ? Math.min(Math.max(i.payout!, 0), 1) : 0;
      let bv = i.bvps!;
      let eps = i.eps!;
      let pv = i.bvps!;
      let ri = 0;
      for (let t = 1; t <= a.years; t++) {
        eps *= 1 + a.g1;
        ri = eps - a.r * bv;
        pv += ri / (1 + a.r) ** t;
        bv += eps * (1 - payout);
      }
      pv += (ri * (1 + a.gT)) / (a.r - a.gT) / (1 + a.r) ** a.years;
      return pv;
    },
  },
  {
    key: 'epv',
    name: '盈餘能力價值 EPV',
    formula: 'Greenwald：正常化盈餘 = 營業利益 × (1 − 稅率) + 折舊攤銷 − 資本支出（近似維持性資本支出），除以 r（零成長永續），加淨現金',
    calc: (i, a) => {
      if (!ok(i.ebitps, a.r) || a.r <= 0) return null;
      const earnings = i.ebitps! * (1 - (a.taxRate ?? 0.21)) + (i.daps ?? 0) - (i.capexps ?? 0);
      return earnings / a.r + (i.cashps ?? 0) - (i.debtps ?? 0);
    },
  },
  {
    key: 'grahamNumber',
    name: '葛拉漢數字 Graham Number',
    formula: '√(22.5 × EPS × 每股淨值)：本益比 15 × 股價淨值比 1.5 = 22.5 的上限價。EPS 或淨值為負時不適用',
    calc: (i) => (i.eps! > 0 && i.bvps! > 0 ? Math.sqrt(22.5 * i.eps! * i.bvps!) : null),
  },
  {
    key: 'grahamFormula',
    name: '葛拉漢成長公式',
    formula: 'EPS × (8.5 + 2g) × 4.4 ÷ Y：g 為未來 7–10 年預期成長率（%），Y 為目前 AAA 公司債殖利率（%）。EPS 為負時不適用',
    calc: (i, a) => (i.eps! > 0 && ok(a.gGraham, a.aaaYield) && a.aaaYield! > 0 ? (i.eps! * (8.5 + 2 * a.gGraham!) * 4.4) / a.aaaYield! : null),
  },
  {
    key: 'bvps',
    name: '每股淨值（帳面價值）',
    formula: '歸屬母公司股東權益 ÷ 流通股數：清算價值的粗略下限',
    calc: (i) => (ok(i.bvps) ? i.bvps! : null),
  },
  {
    key: 'tbvps',
    name: '每股有形淨值',
    formula: '（股東權益 − 商譽 − 無形資產）÷ 流通股數',
    calc: (i) => (ok(i.tbvps) ? i.tbvps! : null),
  },
];

export function runModels(inputs: ValuationInputs, assumptions: ValuationAssumptions): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const m of MODELS) {
    let v: number | null = null;
    try {
      v = m.calc(inputs, assumptions);
    } catch {
      v = null;
    }
    out[m.key] = ok(v) ? v : null;
  }
  return out;
}

// Compound annual growth between two values `years` apart; null when not meaningful.
export function cagr(from: number | null | undefined, to: number | null | undefined, years: number | null | undefined): number | null {
  if (!ok(from, to, years) || from! <= 0 || to! <= 0 || years! <= 0) return null;
  return (to! / from!) ** (1 / years!) - 1;
}

export const clamp = (x: number | null | undefined, lo: number, hi: number): number | null => (x == null ? null : Math.min(hi, Math.max(lo, x)));

// ---- relative multiples (shared so the page can re-run them at a typed-in price) ----

const nz = (x: number | null | undefined) => x ?? 0;

// per-share figures `ps` (eps, bvps, revenueps, ocfps, fcfps, ebitdaps, dps)
// and net debt per share -> the multiples at `price`
/** The per-share figures the multiples are taken against. */
export interface PerShare {
  eps?: number | null;
  bvps?: number | null;
  revenueps?: number | null;
  ocfps?: number | null;
  fcfps?: number | null;
  ebitdaps?: number | null;
  dps?: number | null;
  [key: string]: number | null | undefined;
}

/** Every multiple at one price. */
export type Multiples = Record<string, number | null>;

export function multiplesAt(price: number | null | undefined, ps: PerShare | null | undefined, netDebtPs?: number | null): Multiples {
  if (!ok(price) || !ps) return {};
  const ev = price! + nz(netDebtPs);
  return {
    pe: ps.eps! > 0 ? price! / ps.eps! : null,
    pb: ps.bvps! > 0 ? price! / ps.bvps! : null,
    ps: ps.revenueps! > 0 ? price! / ps.revenueps! : null,
    pocf: ps.ocfps! > 0 ? price! / ps.ocfps! : null,
    pfcf: ps.fcfps! > 0 ? price! / ps.fcfps! : null,
    evEbitda: ps.ebitdaps! > 0 ? ev / ps.ebitdaps! : null,
    evSales: ps.revenueps! > 0 ? ev / ps.revenueps! : null,
    divYield: ps.dps != null ? (ps.dps / price!) * 100 : null,
    earningsYield: ps.eps != null ? (ps.eps / price!) * 100 : null,
    fcfYield: ps.fcfps != null ? (ps.fcfps / price!) * 100 : null,
  };
}

// price implied by applying a multiple (def.kind: price | ev | yield) to per-share figures
/** A multiple: which per-share figure it is taken against, and how. */
export interface MultipleDef {
  metric: string;
  kind: 'price' | 'ev' | 'yield';
}

export function impliedPrice(def: MultipleDef, multiple: number | null | undefined, ps: PerShare | null | undefined, netDebtPs?: number | null): number | null {
  const metric = ps?.[def.metric];
  if (!ok(multiple, metric)) return null;
  if (def.kind === 'price') return multiple! * metric!;
  if (def.kind === 'ev') return multiple! * metric! - nz(netDebtPs);
  return multiple! > 0 ? (metric! / multiple!) * 100 : null; // yield in %
}
