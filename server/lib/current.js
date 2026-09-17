// "Current period" view of a filing: strip every comparative column so each
// statement shows just the period the filing is about.
//   balance sheet   the period-end balance
//   income / OCI    the three-month column of a 10-Q (full year of a 10-K)
//   cash flow       10-Qs usually only report year-to-date, so the quarter is
//                   derived as YTD − previous 10-Q's YTD; opening cash is the
//                   previous quarter's closing balance
//   equity          opening balance, the period's movements, closing balance
// Dimensional columns (equity components, product lines) are kept per group.

import { dimKey, findColumn, months, near } from './quarters.js';

const normLabel = (l) => (l || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Matching row in another statement; when a column id is given, prefer the
// row (of possibly several with the same concept) that has a value there.
function rowIn(stmt, row, colId = null) {
  const rows = stmt.lineItems.filter((li) => !li.abstract);
  const same = rows.filter((li) => li.concept === row.concept);
  if (colId) {
    const hit = same.find((li) => li.values[colId] != null);
    if (hit) return hit;
  }
  return same[0] || rows.find((li) => normLabel(li.label) === normLabel(row.label)) || null;
}

const isStartRow = (li) => /periodStart/i.test(li.preferredLabel || '');
const isEndRow = (li) => /periodEnd/i.test(li.preferredLabel || '');

function numeric(cell) {
  return cell && typeof cell.value === 'number' && !cell.nil ? cell.value : null;
}

function prevDay(d) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
function nextDay(d) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

// The longest duration column ending at `end` for a dimension group: the
// year-to-date column, never the shared three-month net-income context.
function longestEnding(stmt, dims, end) {
  let best = null;
  for (const c of stmt?.columns || []) {
    if (c.period.instant || dimKey(c.dimensions) !== dims || !near(c.period.end, end)) continue;
    if (!best || months(c.period.start, c.period.end) > months(best.period.start, best.period.end)) best = c;
  }
  return best;
}

function groupsOf(stmt) {
  const seen = new Map();
  for (const c of stmt.columns) {
    const k = dimKey(c.dimensions);
    if (!seen.has(k)) seen.set(k, c.dimensions);
  }
  return [...seen.entries()];
}

function finish(stmt, columns, extra = {}) {
  const keep = new Set(columns.map((c) => c.id));
  const lineItems = stmt.lineItems
    .map((li) => ({ ...li, values: Object.fromEntries(Object.entries(li.values).filter(([id]) => keep.has(id))) }))
    .filter((li) => li.abstract || Object.keys(li.values).length);
  return { ...stmt, columns, lineItems, currentOnly: true, ...extra };
}

function countOf(stmt, colId) {
  return stmt.lineItems.filter((li) => !li.abstract && li.values[colId] != null).length;
}

// Direct selection: columns that belong to the filing's own period.
function directColumns(stmt, end, len, isInstantStatement) {
  const out = [];
  for (const c of stmt.columns) {
    if (c.period.instant) {
      const closing = near(c.period.instant, end);
      const opening = !isInstantStatement && c.period.instant < end && months(c.period.instant, end) === len;
      if (closing) out.push({ ...c, label: isInstantStatement ? '本期末' : '期末' });
      else if (opening) out.push({ ...c, label: '期初' });
    } else if (near(c.period.end, end) && months(c.period.start, c.period.end) === len) {
      out.push({ ...c, label: '本期' });
    }
  }
  return out;
}

function orderColumns(columns) {
  const rank = (c) => (c.label === '期初' ? 0 : c.label === '本期' ? 1 : 2);
  return columns
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const da = Object.keys(a.c.dimensions).length - Object.keys(b.c.dimensions).length;
      if (da) return da;
      const ka = dimKey(a.c.dimensions);
      const kb = dimKey(b.c.dimensions);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return rank(a.c) - rank(b.c) || a.i - b.i;
    })
    .map((x) => x.c);
}

// Quarter = this filing's YTD − the previous 10-Q's YTD, per dimension group.
function deriveFromYtd(stmt, prevStmt, end, prevEnd, accession, prevAccession) {
  const columns = [];
  const values = {}; // lineItem index -> { colId: cell }
  for (const [dims, dimensions] of groupsOf(stmt)) {
    const sfx = dims ? `|${dims}` : '';
    const cur = longestEnding(stmt, dims, end);
    const prev = longestEnding(prevStmt, dims, prevEnd);
    const closing = stmt.columns.find((c) => dimKey(c.dimensions) === dims && c.period.instant && near(c.period.instant, end));
    const opening = findColumn(prevStmt, { dims, instant: prevEnd });
    if (opening) columns.push({ id: `open${sfx}`, label: '期初', period: { instant: prevEnd }, dimensions, derived: false, source: prevAccession });
    if (cur && prev) {
      columns.push({ id: `cur${sfx}`, label: '本期', period: { start: nextDay(prevEnd), end }, dimensions, derived: true, source: [accession, prevAccession] });
    }
    if (closing) columns.push({ ...closing, label: '期末' });

    stmt.lineItems.forEach((li, idx) => {
      if (li.abstract) return;
      const v = (values[idx] ||= {});
      if (opening && !isEndRow(li)) {
        const openRow = rowIn(prevStmt, li, opening.id);
        const cell = openRow?.values[opening.id];
        if (cell) v[`open${sfx}`] = { ...cell, source: prevAccession };
      }
      const prevRow = rowIn(prevStmt, li, prev?.id);
      if (cur && prev) {
        const a = numeric(li.values[cur.id]);
        const b = prevRow ? numeric(prevRow.values[prev.id]) : null;
        const unit = li.values[cur.id]?.unit;
        if (a != null && b != null) {
          const approx = unit && unit.includes('/');
          v[`cur${sfx}`] = { value: a - b, unit, derived: true, ...(approx ? { approx: true } : {}) };
        } else if (a != null && prevRow == null && prev) {
          // line item did not exist last quarter: treat previous YTD as 0
          v[`cur${sfx}`] = { value: a, unit, derived: true };
        }
      }
      if (closing && li.values[closing.id] && !isStartRow(li)) v[closing.id] = li.values[closing.id];
    });
  }
  const lineItems = stmt.lineItems.map((li, idx) => ({ ...li, values: values[idx] || {} })).filter((li) => li.abstract || Object.keys(li.values).length);
  return { ...stmt, columns: orderColumns(columns), lineItems, currentOnly: true, derivedFromYtd: true, sources: [accession, prevAccession] };
}

// Collapse 期初 / 本期 / 期末 of each dimension group into one column, the way
// the printed statement reads: opening-balance rows take the opening instant,
// flow rows the period amount, closing-balance rows the closing instant.
function mergePeriodColumns(stmt) {
  const groups = new Map(); // dims -> { open, cur, close }
  for (const c of stmt.columns) {
    const k = dimKey(c.dimensions);
    const g = groups.get(k) || { dimensions: c.dimensions };
    if (c.label === '期初') g.open = c;
    else if (c.label === '期末') g.close = c;
    else g.cur = c;
    groups.set(k, g);
  }
  const columns = [];
  const pick = {}; // merged id -> [ordered source ids]
  for (const [k, g] of groups) {
    const base = g.cur || g.close || g.open;
    const id = `p${k ? `|${k}` : ''}`;
    const start = g.cur?.period.start || (g.open ? nextDay(g.open.period.instant) : null);
    const end = g.cur?.period.end || g.close?.period.instant || g.open?.period.instant;
    columns.push({
      id,
      label: g.cur?.label || '本期',
      period: start ? { start, end } : { instant: end },
      dimensions: g.dimensions,
      derived: !!g.cur?.derived,
      merged: true,
      opening: g.open?.period.instant || null,
      closing: g.close?.period.instant || null,
      source: base.source,
    });
    pick[id] = [g.cur, g.close, g.open].filter(Boolean).map((c) => c.id);
  }
  const lineItems = stmt.lineItems.map((li) => {
    const values = {};
    for (const [id, srcs] of Object.entries(pick)) {
      const src = srcs.find((sid) => li.values[sid] != null);
      if (src) values[id] = li.values[src];
    }
    return { ...li, values };
  });
  return { ...stmt, columns, lineItems };
}

const NET_CHANGE = /(CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecrease|CashAndCashEquivalentsPeriodIncreaseDecrease|IncreaseDecreaseInCashAndCashEquivalents)/;

// Present the roll-forward top to bottom - opening balance first, movements,
// closing balance last - and check that opening + movements = closing.
function rollForward(stmt) {
  const items = stmt.lineItems;
  // opening rows go right under the statement heading (cash-flow statements
  // tag them at the bottom); closing rows stay where the filer put them
  const opening = items.filter((li) => isStartRow(li));
  const rest = items.filter((li) => !isStartRow(li));
  let cut = 0;
  while (cut < rest.length && rest[cut].abstract && rest[cut].depth === 0) cut++;
  const lineItems = [...rest.slice(0, cut), ...opening, ...rest.slice(cut)];

  // Filers often tag a movement only in a finer breakdown (e.g. "stock issued"
  // per share class, dividends only under Retained Earnings). When a row has
  // no value in a column, sum the columns that add exactly one more axis.
  const subColumns = (col) => {
    const base = Object.entries(col.dimensions);
    return stmt.columns.filter((c) => {
      const d = Object.entries(c.dimensions);
      return d.length === base.length + 1 && base.every(([k, v]) => c.dimensions[k] === v);
    });
  };
  const valueOrRollup = (li, col) => {
    const own = li.values[col.id];
    if (own && typeof own.value === 'number') return { value: own.value, unit: own.unit, rolled: false };
    const byAxis = new Map();
    for (const c of subColumns(col)) {
      const cell = li.values[c.id];
      if (!cell || typeof cell.value !== 'number') continue;
      const axis = Object.keys(c.dimensions).find((k) => !(k in col.dimensions));
      const g = byAxis.get(axis) || { value: 0, unit: cell.unit };
      g.value += cell.value;
      byAxis.set(axis, g);
    }
    const first = byAxis.values().next().value;
    return first ? { ...first, rolled: true } : null;
  };

  const reconciliation = {};
  for (const col of stmt.columns) {
    const cell = (li) => li.values[col.id];
    const open = opening.map(cell).find((c) => c && typeof c.value === 'number' && !/shares|pure/.test(c.unit || ''));
    const close = items
      .filter(isEndRow)
      .map(cell)
      .find((c) => c && typeof c.value === 'number' && !/shares|pure/.test(c.unit || ''));
    if (!open || !close) continue;
    let movements;
    let method;
    if (stmt.type === 'cash_flow') {
      const net = items.find((li) => NET_CHANGE.test(li.concept) && cell(li) && typeof cell(li).value === 'number');
      if (!net) continue;
      movements = cell(net).value;
      method = 'net';
    } else {
      movements = 0;
      let rolled = 0;
      let prevHadValue = false;
      for (const li of items) {
        if (li.abstract) {
          prevHadValue = false;
          continue;
        }
        if (isStartRow(li) || isEndRow(li)) continue;
        const c = valueOrRollup(li, col);
        const has = !!c && c.unit === open.unit;
        // a "total" row following detail rows in the same section is their
        // subtotal (IFRS filers list net income, OCI, then total comprehensive income)
        const subtotal = /total/i.test(li.preferredLabel || '') && prevHadValue;
        prevHadValue = prevHadValue || has;
        if (!has || subtotal) continue;
        movements += li.negated ? -c.value : c.value;
        if (c.rolled) rolled++;
      }
      method = rolled ? 'sum+rollup' : 'sum';
    }
    const computed = open.value + movements;
    const diff = close.value - computed;
    // rounding: filers report in thousands/millions (decimals = -3 / -6)
    const decimals = Number(close.decimals ?? open.decimals ?? 0);
    const tolerance = Math.max(1, 2 * 10 ** (decimals < 0 ? -decimals : 0));
    reconciliation[col.id] = { opening: open.value, movements, computed, closing: close.value, diff, ok: Math.abs(diff) <= tolerance, method, unit: open.unit };
  }
  return { ...stmt, lineItems, reconciliation };
}

export function currentView(data, filing, prev) {
  const end = filing.reportDate || data.filing.periodEnd;
  const form = (filing.form || data.filing.form || '').toUpperCase();
  const isQuarterly = form.startsWith('10-Q');
  const len = isQuarterly ? 3 : 12;
  // notes: what was derived, as { code, ...params } for the UI to word
  const notes = [];

  const convert = (stmt) => {
    if (!stmt) return null;
    const isInstantStatement = stmt.type === 'balance_sheet' || stmt.columns.every((c) => c.period.instant);
    let cols = directColumns(stmt, end, len, isInstantStatement);
    const ytd = longestEnding(stmt, '', end);
    // A three-month column that only carries a handful of facts (typically
    // net income, whose context is shared with the income statement) is not
    // a real quarterly presentation: fall through to the YTD derivation.
    const main = cols.find((c) => c.label === '本期' && !Object.keys(c.dimensions).length);
    const ytdIsLonger = ytd && months(ytd.period.start, ytd.period.end) > len;
    const realQuarter = main && (!ytdIsLonger || countOf(stmt, main.id) >= countOf(stmt, ytd.id) * 0.5);
    if (isInstantStatement || (main && realQuarter)) {
      return finish(stmt, orderColumns(cols));
    }
    if (!ytdIsLonger) return finish(stmt, orderColumns(cols));
    const prevStmt = prev?.data?.allStatements.find((s) => s.role === stmt.role) || prev?.data?.allStatements.find((s) => s.type === stmt.type && !s.parenthetical);
    if (prevStmt && prev.filing.reportDate) {
      notes.push({ code: 'derived', title: stmt.title, form: prev.filing.form, fiscalYear: prev.filing.fiscalYear, fiscalPeriod: prev.filing.fiscalPeriod });
      return deriveFromYtd(stmt, prevStmt, end, prev.filing.reportDate, filing.accession, prev.filing.accession);
    }
    // no previous filing available: show YTD and say so
    notes.push({ code: 'ytdOnly', title: stmt.title, start: ytd.period.start, end: ytd.period.end });
    const ytdCols = stmt.columns.filter((c) => (c.period.instant && (near(c.period.instant, end) || near(c.period.instant, prevDay(ytd.period.start)))) || (c.period.end && near(c.period.end, end) && !c.period.instant));
    return finish(
      stmt,
      orderColumns(ytdCols.map((c) => ({ ...c, label: c.period.instant ? (near(c.period.instant, end) ? '期末' : '期初') : '年初至今' }))),
      { ytdOnly: true },
    );
  };

  const allStatements = data.allStatements.map((st) => {
    const c = convert(st);
    return c && c.columns.some((col) => col.label === '期初' || col.label === '期末') ? rollForward(mergePeriodColumns(c)) : c;
  });
  const byRole = Object.fromEntries(allStatements.map((s) => [s.role, s]));
  const statements = Object.fromEntries(Object.entries(data.statements).map(([k, s]) => [k, s ? byRole[s.role] : null]));
  return { ...data, view: 'current', statements, allStatements, notes, previous: prev ? { accession: prev.filing.accession, form: prev.filing.form, fiscalYear: prev.filing.fiscalYear, fiscalPeriod: prev.filing.fiscalPeriod, reportDate: prev.filing.reportDate } : null };
}
