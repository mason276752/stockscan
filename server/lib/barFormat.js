// The daily-bar file format and the arithmetic on saved series - pure
// functions shared by the server's bar store and the static site (which
// reads the same files in the browser).
//
// A file holds the bars of one calendar year as columnar JSON, zstd'd:
//   { d: decimals, t: [day deltas], o, h, l, c: [price deltas], v: [volumes] }
// t[0] is days since the epoch, the rest deltas; o and c are relative to the
// previous close (the first bar's to 0), h and l to the bar's own close.
// Prices are integers with `d` decimals. Half the bytes of row JSON.
//
// A split at the source shifts every earlier bar. The saved files are not
// rewritten: meta.adjust = [{ date, price, volume }] and the bars before
// `date` are multiplied by the factors when read (`adjusted`); volume null
// means 1 / price.

const DAY = 86_400_000;
export const TOL = 0.005; // closes within half a percent are the same bar
// Trim the float noise a split factor leaves behind (1.7670000000000002),
// by significant digits rather than decimal places: rounding to six decimals
// would turn a sub-cent quote into 0.
export const round = (x) => Number(x.toPrecision(12));
export const same = (a, b) => Math.abs(a / b - 1) <= TOL;
export const yearOf = (bar) => bar.date.slice(0, 4);

// How many decimals a price needs, read off its exponential form: a number
// JavaScript prints as "4e-7" has no '.' in it at all, and taking that for
// an integer is what used to store every sub-cent quote as 0.
export const decimals = (x) => {
  const [mantissa, exp] = Math.abs(x).toExponential().split('e');
  return Math.max(0, (mantissa.split('.')[1] || '').length - Number(exp));
};
// Prices are integers of 10^-d, so d is what the smallest tick in the file
// needs - enough decimals that no price rounds away. The count is taken
// from the price trimmed to twelve significant digits, so a source's float
// noise (0.30000000000000004) does not ask for seventeen decimals, and it
// stops at MAX_DECIMALS whatever arrives. One file holds one year, whose
// prices are of a like size; the delta coding is what limits a file that
// mixes them, not `d`.
const MAX_DECIMALS = 12;
export function decimalsFor(days) {
  let need = 0;
  for (const b of days) for (const v of [b.open, b.high, b.low, b.close]) if (Number.isFinite(v)) need = Math.max(need, decimals(round(v)));
  return Math.min(need, MAX_DECIMALS);
}
export function encodeBars(days) {
  const d = decimalsFor(days);
  const m = 10 ** d;
  const I = (x) => Math.round(x * m);
  const t = [];
  const o = [];
  const h = [];
  const l = [];
  const c = [];
  const v = [];
  let pt = 0;
  let pc = 0;
  for (const b of days) {
    const day = Math.round(Date.parse(b.date) / DAY);
    const close = I(b.close);
    t.push(day - pt);
    o.push(I(b.open) - pc);
    h.push(I(b.high) - close);
    l.push(I(b.low) - close);
    c.push(close - pc);
    v.push(Math.round(b.volume || 0));
    pt = day;
    pc = close;
  }
  return { d, t, o, h, l, c, v };
}
export function decodeBars({ d, t, o, h, l, c, v }) {
  const m = 10 ** d;
  const out = [];
  let pt = 0;
  let pc = 0;
  for (let i = 0; i < t.length; i++) {
    pt += t[i];
    const close = pc + c[i];
    out.push({ date: new Date(pt * DAY).toISOString().slice(0, 10), open: (pc + o[i]) / m, high: (close + h[i]) / m, low: (close + l[i]) / m, close: close / m, volume: v[i] });
    pc = close;
  }
  return out;
}

// ---- adjustments ---------------------------------------------------------
// raw bars (sorted) -> the series as the source reports it today
export function adjusted(days, adjust) {
  if (!adjust?.length) return days;
  return days.map((b) => {
    let price = 1;
    let volume = 1;
    for (const a of adjust) {
      if (b.date < a.date) {
        price *= a.price;
        volume *= a.volume ?? 1 / a.price;
      }
    }
    return price === 1 ? b : { date: b.date, open: round(b.open * price), high: round(b.high * price), low: round(b.low * price), close: round(b.close * price), volume: Math.round(b.volume * volume) };
  });
}
// a current-basis bar -> the raw one the files hold
export function unadjust(b, adjust) {
  let price = 1;
  let volume = 1;
  for (const a of adjust) {
    if (b.date < a.date) {
      price /= a.price;
      volume /= a.volume ?? 1 / a.price;
    }
  }
  return price === 1 ? b : { date: b.date, open: round(b.open * price), high: round(b.high * price), low: round(b.low * price), close: round(b.close * price), volume: Math.round(b.volume * volume) };
}

// 19:15 New York on `date`: a bar fetched before that may still have been
// forming. The classic session closes at 16:00, but from December 2026 the
// US session runs 23 hours (20:00 ET to 19:00 ET the next day, closed
// 19:00-20:00), so the day's bar is only certainly final in that pause.
const NY_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
export function settledAt(date) {
  const noon = Date.parse(`${date}T12:00:00Z`);
  const behind = 12 - (Number(NY_HOUR.format(new Date(noon))) % 24); // hours New York is behind UTC (4 or 5)
  return noon + (7.25 + behind) * 3_600_000;
}

// Compare the incoming series with the saved view over the dates both have:
// { split: { date, price, volume } | null, dates: [bars that differ and must be rewritten] }.
// A split is every bar before some date moved by one factor and nothing
// after it; the `unsettled` bar (still forming when saved) may differ freely.
export function diffSeries(view, incoming, unsettled = null) {
  const byDate = new Map(view.map((b) => [b.date, b]));
  const changed = [];
  const unchanged = [];
  const dates = [];
  let forming = null; // the bar that was still forming when it was saved
  for (const b of incoming) {
    const old = byDate.get(b.date);
    if (!old) continue;
    const row = { date: b.date, ratio: b.close / old.close, volume: old.volume && b.volume ? b.volume / old.volume : null };
    if (b.date === unsettled) {
      if (!same(b.close, old.close) || !same(b.volume || 1, old.volume || 1)) forming = row;
      continue;
    }
    (same(b.close, old.close) ? unchanged : changed).push(row);
  }
  if (!changed.length) return { split: null, dates: forming ? [forming.date] : dates };
  const ratio = changed[Math.floor(changed.length / 2)].ratio;
  const oneFactor = changed.every((c) => same(c.ratio, ratio));
  // A bar still forming when it was saved may differ for its own reasons, so
  // it is never evidence of a split - but when it moved by the same factor as
  // everything before it, it is on the old basis too and the new one starts
  // after it. Leaving it out of the shift is what used to date a split a day
  // early and leave that one bar reading as the whole factor out of line.
  const shifted = forming && same(forming.ratio, ratio) ? [...changed, forming] : changed;
  if (forming && shifted.length === changed.length) dates.push(forming.date);
  const firstUnchanged = unchanged[0];
  const prefix = unchanged.every((u) => u.date > shifted.at(-1).date); // every bar before some date changed, none after
  if (prefix && oneFactor && !same(ratio, 1) && changed.length >= 2) {
    // a split scales volume by the inverse of the price factor: recorded as
    // null (1 / price, computed exactly when applied) unless the source's
    // volumes say otherwise (some do not restate them)
    const volumes = changed.map((c) => c.volume).filter((x) => x);
    const vm = volumes.length ? volumes[Math.floor(volumes.length / 2)] : 1 / ratio;
    const volume = Math.abs(vm * ratio - 1) < 0.01 ? null : round(vm);
    // the first bar of the new basis: the first unchanged one, else the day after the last shifted one
    const date = firstUnchanged?.date || new Date(Date.parse(shifted.at(-1).date) + DAY).toISOString().slice(0, 10);
    return { split: { date, price: round(ratio), volume }, dates };
  }
  return { split: null, dates: [...dates, ...changed.map((c) => c.date)] };
}

// Splice freshly fetched bars (the tail of the series, fetched with a few
// days of overlap) onto the saved ones. The overlap must agree - a split or
// an adjustment change since the last fetch shifts the whole history, and
// then only a full refetch is right: returns null. The saved bar of
// `unsettled` (fetched during its session, so still forming) may differ.
export function mergeDays(saved, fresh, unsettled = null) {
  if (!fresh.length) return saved;
  if (!saved.length) return fresh;
  const first = fresh[0].date;
  if (saved.at(-1).date < first) return null; // no overlap: cannot tell whether the history still matches
  const byDate = new Map(fresh.map((d) => [d.date, d]));
  let checked = 0;
  for (const d of saved) {
    if (d.date < first) continue;
    const f = byDate.get(d.date);
    if (!f) continue;
    if (d.date === unsettled) continue;
    checked++;
    if (!same(f.close, d.close)) return null;
  }
  if (!checked) return null; // the only shared bar was the one still forming: nothing was verified
  return [...saved.filter((d) => d.date < first), ...fresh];
}
