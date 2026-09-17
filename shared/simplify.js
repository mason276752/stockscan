// Simplified view of a primary statement: only the undimensioned ("total")
// columns are shown. A line the filer tagged only per member - stock issued
// per share class, cost of revenue per product line, shares outstanding per
// class - is rolled up by summing the members of one axis into the total
// column; such cells carry `rolled` with the members that went in.

const local = (s) => s.split(':').pop();
const short = (m) => local(m).replace(/Member$/, '');
const isSubtotalMember = (m) => /Total|Aggregate/i.test(local(m));
const isParent = (m) => local(m) === 'ParentMember';
const isNci = (m) => local(m) === 'NoncontrollingInterestMember';
const dimCount = (c) => Object.keys(c.dimensions || {}).length;
const dateNum = (d) => (d ? Number(d.replace(/-/g, '')) : 0);
const periodKey = (c) => (c.merged ? 'p' : c.period.instant ? `i:${c.period.instant}` : `d:${c.period.start}~${c.period.end}`);

// Newest period first, an instant before the durations ending on it, the
// shorter duration first - the order the filing's own columns come in.
function comparePeriods(a, b) {
  const ea = dateNum(a.period.instant || a.period.end);
  const eb = dateNum(b.period.instant || b.period.end);
  if (ea !== eb) return eb - ea;
  if (!a.period.instant !== !b.period.instant) return a.period.instant ? -1 : 1;
  return dateNum(b.period.start) - dateNum(a.period.start);
}

// Same period as the total column. Merged columns (期初 / 本期 / 期末 collapsed
// into one) are one per dimension group, all for the same period.
function samePeriod(a, b) {
  if (a.merged && b.merged) return true;
  if (a.period.instant || b.period.instant) return a.period.instant === b.period.instant;
  return a.period.start === b.period.start && a.period.end === b.period.end;
}

// Roll a line's members up into `col`. Member columns are grouped by the
// set of axes they carry; a group whose columns differ in at most one axis
// is a breakdown along that axis (share classes, product lines, equity
// components) and its members sum to the total. A lone column carrying a
// member the filer used for the whole line (a cash-flow line tagged only
// with the credit facility it concerns) is taken as is.
function rollup(li, col, memberCols) {
  const groups = new Map(); // axis set -> [{ dims, cell }]
  for (const c of memberCols) {
    const cell = li.values[c.id];
    if (!cell || typeof cell.value !== 'number' || cell.nil) continue;
    const key = Object.keys(c.dimensions).sort().join('|');
    const list = groups.get(key) || [];
    list.push({ dims: c.dimensions, cell });
    groups.set(key, list);
  }
  let best = null;
  for (let list of groups.values()) {
    const axes = Object.keys(list[0].dims);
    const varying = axes.filter((a) => new Set(list.map((x) => x.dims[a])).size > 1);
    if (varying.length > 1) continue;
    const axis = varying[0];
    let members;
    if (axis) {
      list = list.filter((x) => !isSubtotalMember(x.dims[axis]));
      // ParentMember is itself the sum of the equity components: drop it when
      // any component is present, keep it next to the non-controlling interest
      if (list.some((x) => isParent(x.dims[axis])) && list.some((x) => !isParent(x.dims[axis]) && !isNci(x.dims[axis]))) {
        list = list.filter((x) => !isParent(x.dims[axis]));
      }
      if (!list.length) continue;
      members = list.map((x) => short(x.dims[axis]));
    } else {
      members = list.map((x) => Object.values(x.dims).map(short).join('/'));
    }
    const unit = list[0].cell.unit;
    if (list.some((x) => x.cell.unit !== unit)) continue;
    if (!best || list.length > best.list.length || (list.length === best.list.length && axes.length < best.axes)) best = { list, members, axes: axes.length };
  }
  if (!best) return null;
  const first = best.list[0].cell;
  return {
    value: best.list.reduce((s, x) => s + x.cell.value, 0),
    unit: first.unit,
    decimals: first.decimals,
    scale: first.scale,
    rolled: best.members,
  };
}

// Drop section headings that no longer introduce any line.
function pruneHeadings(items) {
  const keep = new Array(items.length).fill(false);
  for (let i = items.length - 1; i >= 0; i--) {
    const li = items[i];
    if (!li.abstract) {
      keep[i] = true;
      continue;
    }
    for (let j = i + 1; j < items.length && items[j].depth > li.depth; j++) {
      if (keep[j] && !items[j].abstract) {
        keep[i] = true;
        break;
      }
    }
  }
  return items.filter((_, i) => keep[i]);
}

export function simplifyStatement(stmt) {
  if (!stmt) return stmt;
  const members = stmt.columns.filter((c) => dimCount(c));
  if (!members.length) return { ...stmt, axes: {}, simplified: true, hiddenGroups: [], rolledCount: 0 };

  // One total column per period: the filer's undimensioned column where
  // there is one, else a synthetic column filled entirely by roll-ups (a
  // 10-Q equity statement carries the prior quarter's roll-forward only in
  // its component columns).
  const byPeriod = new Map();
  for (const c of stmt.columns) {
    const k = periodKey(c);
    if (!dimCount(c)) byPeriod.set(k, c);
    else if (!byPeriod.has(k)) {
      const { id, dimensions, ...rest } = c;
      byPeriod.set(k, { ...rest, id: `sum|${k}`, dimensions: {}, synthetic: true, opening: null, closing: null });
    }
  }
  const labelled = stmt.columns.some((c) => c.label);
  const plain = [...byPeriod.values()];
  if (!labelled) plain.sort(comparePeriods);

  const hidden = new Map();
  for (const c of members) {
    const k = Object.entries(c.dimensions).sort().map(([a, m]) => `${a}=${m}`).join('|');
    if (!hidden.has(k)) hidden.set(k, c.dimensions);
  }

  let rolledCount = 0;
  const lineItems = stmt.lineItems.map((li) => {
    if (li.abstract) return { ...li, values: {} };
    const values = {};
    for (const col of plain) {
      const own = li.values[col.id];
      if (own) {
        values[col.id] = own;
        continue;
      }
      const r = rollup(li, col, members.filter((c) => samePeriod(c, col)));
      if (r) {
        values[col.id] = r;
        rolledCount++;
      }
    }
    return { ...li, values };
  });

  // a synthetic column that ended up empty is noise
  const used = new Set(lineItems.flatMap((li) => Object.keys(li.values)));
  const columns = plain.filter((c) => !c.synthetic || used.has(c.id));

  return {
    ...stmt,
    axes: {},
    columns,
    lineItems: pruneHeadings(lineItems.filter((li) => li.abstract || Object.keys(li.values).length)),
    simplified: true,
    hiddenGroups: [...hidden.values()],
    rolledCount,
  };
}
