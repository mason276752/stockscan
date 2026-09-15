// Assemble the primary financial statements from facts + presentation tree.

import { factsByName } from './ixbrl.js';
import { labelFor } from './taxonomy.js';
import { zhFor } from './zh.js';

// Ordered: the first pattern that matches the statement title wins.
const STATEMENT_TYPES = [
  ['cash_flow', /CASH\s*FLOW/i],
  ['balance_sheet', /BALANCE\s*SHEET|FINANCIAL\s*(POSITION|CONDITION)/i],
  ['comprehensive_income', /COMPREHENSIVE\s*(INCOME|LOSS|EARNINGS)/i],
  ['income_statement', /INCOME|OPERATIONS|EARNINGS|PROFIT|LOSS/i],
  ['equity', /EQUITY|DEFICIT|SHAREHOLDERS|STOCKHOLDERS|CAPITAL/i],
];
export const PRIMARY = ['balance_sheet', 'income_statement', 'cash_flow', 'equity'];

const STRUCTURAL = ['Table', 'Axis', 'Domain', 'Member', 'LineItems'];

export function classify(title) {
  for (const [kind, re] of STATEMENT_TYPES) if (re.test(title)) return kind;
  return 'other';
}

const local = (concept) => concept.split(':').pop();
const isStructural = (concept) => STRUCTURAL.some((s) => local(concept).endsWith(s));
const isAbstract = (concept) => local(concept).endsWith('Abstract');
const dateNum = (d) => (d ? Number(d.replace(/-/g, '')) : 0);

// Flatten the presentation tree into line items, collecting the axes and the
// explicit members declared under each of them.
function walk(nodes, depth, out, axes, currentAxis = null) {
  for (const n of nodes) {
    const l = local(n.concept);
    if (l.endsWith('Axis')) {
      axes[n.concept] ||= new Set();
      walk(n.children, depth, out, axes, n.concept);
    } else if (l.endsWith('Member') && currentAxis) {
      axes[currentAxis].add(n.concept);
      walk(n.children, depth, out, axes, currentAxis);
    } else if (isStructural(n.concept)) {
      walk(n.children, depth, out, axes, currentAxis);
    } else {
      out.push([n, depth]);
      walk(n.children, depth + 1, out, axes, currentAxis);
    }
  }
}

// A fact belongs to a statement when each dimension of its context is an axis
// of that statement and the member is one the statement lists (an axis with
// only a domain and no explicit members accepts any member).
function contextAllowed(ctx, axes) {
  for (const [dim, member] of Object.entries(ctx.dimensions)) {
    if (!(dim in axes)) return false;
    if (axes[dim].size && !axes[dim].has(member)) return false;
  }
  return true;
}

function dimKey(ctx) {
  return Object.entries(ctx.dimensions)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
}

// Undimensioned columns first, then grouped by dimension, newest period first.
function compareContexts(a, b) {
  const da = Object.keys(a.dimensions).length;
  const db = Object.keys(b.dimensions).length;
  if (da !== db) return da - db;
  const ka = dimKey(a);
  const kb = dimKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  const ea = dateNum(a.instant || a.end);
  const eb = dateNum(b.instant || b.end);
  if (ea !== eb) return eb - ea;
  if (!a.instant !== !b.instant) return a.instant ? -1 : 1;
  return dateNum(b.start) - dateNum(a.start);
}

function prevDay(d) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

// Drop stray instant columns: a balance carried in from another statement
// (e.g. prior-year StockholdersEquity from the equity roll-forward landing on
// the balance sheet) shows up as an undimensioned instant column with one or
// two facts. Real opening/closing balances (cash flow, equity) are kept
// because a duration column in the same statement brackets their date.
function pruneColumns(columns, counts) {
  const plain = columns.filter((c) => !Object.keys(c.dimensions).length);
  if (!plain.length) return columns;
  const max = Math.max(...plain.map((c) => counts[c.id]));
  const threshold = Math.max(1, Math.floor(max / 10));
  const durations = plain.filter((c) => !c.instant).map((c) => [dateNum(prevDay(c.start)), dateNum(c.end)]);
  const stray = (c) => {
    if (Object.keys(c.dimensions).length || !c.instant || counts[c.id] > threshold) return false;
    const d = dateNum(c.instant);
    return !durations.some(([lo, hi]) => lo <= d && d <= hi);
  };
  return columns.filter((c) => !stray(c));
}

function factJson(fact, units) {
  const j = { value: fact.value, raw: fact.raw, unit: fact.unitRef ? units[fact.unitRef] || fact.unitRef : null };
  if (fact.numeric) Object.assign(j, { decimals: fact.decimals, scale: fact.scale, sign: fact.sign, format: fact.format });
  if (fact.nil) j.nil = true;
  if (fact.id) j.factId = fact.id;
  return j;
}

export function buildStatement(role, doc, tax, byName, concepts = {}) {
  const rows = [];
  const axes = {};
  walk(role.roots, 0, rows, axes);

  const used = {};
  const lineItems = [];
  for (const [node, depth] of rows) {
    const meta = concepts[node.concept] || {};
    const item = {
      concept: node.concept,
      label: labelFor(tax.labels, node.concept, node.preferredLabel),
      // standard (non-terse) label and definition from the filing's MetaLinks.json
      labelStandard: meta.label || null,
      documentation: meta.documentation || null,
      ...zhFor(node.concept),
      preferredLabel: node.preferredLabel ? node.preferredLabel.split('/').pop() : null,
      // values are the raw XBRL amounts; the filer displays this row with the
      // sign flipped when negated is true
      negated: /negated/i.test(node.preferredLabel || ''),
      depth,
      abstract: isAbstract(node.concept),
      values: {},
    };
    for (const fact of byName.get(node.concept) || []) {
      const ctx = doc.contexts[fact.contextRef];
      if (!ctx || !contextAllowed(ctx, axes)) continue;
      used[ctx.id] = ctx;
      item.values[ctx.id] = factJson(fact, doc.units);
    }
    if (Object.keys(item.values).length || item.abstract) lineItems.push(item);
  }

  const counts = Object.fromEntries(Object.keys(used).map((id) => [id, 0]));
  for (const item of lineItems) for (const id of Object.keys(item.values)) counts[id]++;
  const columns = pruneColumns(Object.values(used).sort(compareContexts), counts);
  const keep = new Set(columns.map((c) => c.id));
  for (const item of lineItems) {
    item.values = Object.fromEntries(Object.entries(item.values).filter(([id]) => keep.has(id)));
  }

  return {
    type: classify(role.title),
    title: role.title,
    role: role.uri,
    parenthetical: /parenthetical/i.test(role.title),
    axes: Object.fromEntries(Object.entries(axes).map(([a, m]) => [a, [...m].sort()])),
    columns: columns.map((c) => ({
      id: c.id,
      period: c.instant ? { instant: c.instant } : { start: c.start, end: c.end },
      dimensions: c.dimensions,
    })),
    lineItems,
  };
}

export function buildStatements(doc, tax, concepts = {}) {
  const byName = factsByName(doc);
  const roles = Object.values(tax.roles)
    .filter((r) => r.kind.toLowerCase() === 'statement' && r.roots.length)
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const all = roles.map((r) => buildStatement(r, doc, tax, byName, concepts));

  const primary = Object.fromEntries(PRIMARY.map((k) => [k, null]));
  for (const st of all) if (st.type in primary && !primary[st.type] && !st.parenthetical) primary[st.type] = st;
  // IFRS filers often present a single combined statement of profit or loss
  // and other comprehensive income.
  if (!primary.income_statement) {
    primary.income_statement = all.find((st) => st.type === 'comprehensive_income' && !st.parenthetical) || null;
  }
  return { statements: primary, allStatements: all };
}
