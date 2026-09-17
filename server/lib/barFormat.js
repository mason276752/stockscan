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
export const round = (x) => Math.round(x * 1e6) / 1e6;
export const same = (a, b) => Math.abs(a / b - 1) <= TOL;
export const yearOf = (bar) => bar.date.slice(0, 4);

const decimals = (x) => {
  const s = String(x);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(6, s.length - i - 1);
};
export function encodeBars(days) {
  const d = Math.max(0, ...days.map((b) => Math.max(decimals(b.open), decimals(b.high), decimals(b.low), decimals(b.close))));
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
  for (const b of incoming) {
    const old = byDate.get(b.date);
    if (!old) continue;
    if (b.date === unsettled) {
      if (!same(b.close, old.close) || !same(b.volume || 1, old.volume || 1)) dates.push(b.date);
      continue;
    }
    (same(b.close, old.close) ? unchanged : changed).push({ date: b.date, ratio: b.close / old.close, volume: old.volume && b.volume ? b.volume / old.volume : null });
  }
  if (!changed.length) return { split: null, dates };
  const firstUnchanged = unchanged[0];
  const prefix = unchanged.every((u) => u.date > changed.at(-1).date); // every bar before some date changed, none after
  const ratio = changed[Math.floor(changed.length / 2)].ratio;
  const oneFactor = changed.every((c) => same(c.ratio, ratio));
  if (prefix && oneFactor && !same(ratio, 1) && changed.length >= 2) {
    // a split scales volume by the inverse of the price factor: recorded as
    // null (1 / price, computed exactly when applied) unless the source's
    // volumes say otherwise (some do not restate them)
    const volumes = changed.map((c) => c.volume).filter((x) => x);
    const vm = volumes.length ? volumes[Math.floor(volumes.length / 2)] : 1 / ratio;
    const volume = Math.abs(vm * ratio - 1) < 0.01 ? null : round(vm);
    // the first bar of the new basis: the first unchanged one, else the day after the last changed one
    const date = firstUnchanged?.date || new Date(Date.parse(changed.at(-1).date) + DAY).toISOString().slice(0, 10);
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
  if (!checked && saved.at(-1).date !== unsettled) return null;
  return [...saved.filter((d) => d.date < first), ...fresh];
}
