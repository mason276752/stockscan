// Assemble the primary financial statements from facts + presentation tree.

import { factsByName } from './ixbrl.ts';
import { labelFor } from './taxonomy.ts';
import { zhFor } from './zh.ts';
import { PRIMARY, classify, pickPrimary, reclassify } from './statementTypes.ts';
import type { Concept, ConceptMeta, FactValue, IsoDate, LineItem, PrimaryStatements, Statement, StatementColumn, Taxonomy, TaxonomyNode, TaxonomyRole, XbrlContext, XbrlDoc, XbrlFact } from './types.ts';

export { PRIMARY, classify, pickPrimary, reclassify };

// Ordered: the first pattern that matches the statement title wins.
const STRUCTURAL = ['Table', 'Axis', 'Domain', 'Member', 'LineItems'];

const local = (concept: Concept) => concept.split(':').pop()!;
const isStructural = (concept: Concept) => STRUCTURAL.some((s) => local(concept).endsWith(s));
const isAbstract = (concept: Concept) => local(concept).endsWith('Abstract');
const dateNum = (d: IsoDate | null | undefined) => (d ? Number(d.replace(/-/g, '')) : 0);

/** The axes a statement declares, each with the members listed under it. */
type AxisIndex = Record<Concept, Set<Concept>>;

// Flatten the presentation tree into line items, collecting the axes and the
// explicit members declared under each of them.
function walk(nodes: readonly TaxonomyNode[], depth: number, out: [TaxonomyNode, number][], axes: AxisIndex, currentAxis: Concept | null = null): void {
  for (const n of nodes) {
    const l = local(n.concept);
    if (l.endsWith('Axis')) {
      axes[n.concept] ||= new Set();
      walk(n.children, depth, out, axes, n.concept);
    } else if (l.endsWith('Member') && currentAxis) {
      axes[currentAxis]!.add(n.concept);
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
function contextAllowed(ctx: XbrlContext, axes: AxisIndex): boolean {
  for (const [dim, member] of Object.entries(ctx.dimensions)) {
    if (!(dim in axes)) return false;
    if (axes[dim]!.size && !axes[dim]!.has(member)) return false;
  }
  return true;
}

function dimKey(ctx: XbrlContext): string {
  return Object.entries(ctx.dimensions)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
}

// Undimensioned columns first, then grouped by dimension, newest period first.
export function compareContexts(a: XbrlContext, b: XbrlContext): number {
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

function prevDay(d: IsoDate): IsoDate {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

// Drop stray instant columns: a balance carried in from another statement
// (e.g. prior-year StockholdersEquity from the equity roll-forward landing on
// the balance sheet) shows up as an undimensioned instant column with one or
// two facts. Real opening/closing balances (cash flow, equity) are kept
// because a duration column in the same statement brackets their date.
export function pruneColumns(columns: readonly XbrlContext[], counts: Record<string, number>): XbrlContext[] {
  const plain = columns.filter((c) => !Object.keys(c.dimensions).length);
  if (!plain.length) return [...columns];
  const max = Math.max(...plain.map((c) => counts[c.id]!));
  const threshold = Math.max(1, Math.floor(max / 10));
  const durations: [number, number][] = plain.filter((c) => !c.instant).map((c) => [dateNum(prevDay(c.start!)), dateNum(c.end)]);
  const stray = (c: XbrlContext) => {
    if (Object.keys(c.dimensions).length || !c.instant || counts[c.id]! > threshold) return false;
    const d = dateNum(c.instant);
    return !durations.some(([lo, hi]) => lo <= d && d <= hi);
  };
  return columns.filter((c) => !stray(c));
}

function factJson(fact: XbrlFact, units: Record<string, string>): FactValue {
  const j: FactValue = { value: fact.value, raw: fact.raw, unit: fact.unitRef ? units[fact.unitRef] || fact.unitRef : null };
  if (fact.numeric) Object.assign(j, { decimals: fact.decimals, scale: fact.scale, sign: fact.sign, format: fact.format });
  if (fact.nil) j.nil = true;
  if (fact.id) j.factId = fact.id;
  return j;
}

export function buildStatement(role: TaxonomyRole, doc: XbrlDoc, tax: Taxonomy, byName: Map<Concept, XbrlFact[]>, concepts: Record<Concept, ConceptMeta> = {}): Statement {
  const rows: [TaxonomyNode, number][] = [];
  const axes: AxisIndex = {};
  walk(role.roots, 0, rows, axes);

  const used: Record<string, XbrlContext> = {};
  const lineItems: LineItem[] = [];
  for (const [node, depth] of rows) {
    const meta: Partial<ConceptMeta> = concepts[node.concept] || {};
    const item: LineItem = {
      concept: node.concept,
      label: labelFor(tax.labels, node.concept, node.preferredLabel),
      // standard (non-terse) label and definition from the filing's MetaLinks.json
      labelStandard: meta.label || null,
      documentation: meta.documentation || null,
      ...zhFor(node.concept),
      preferredLabel: node.preferredLabel ? node.preferredLabel.split('/').pop()! : null,
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

  // The same balance concept usually appears twice in a cash-flow or equity
  // statement: once as "beginning of period" (periodStartLabel) and once as
  // "end of period" (periodEndLabel). Both rows would otherwise carry every
  // instant; keep only the instants that open, respectively close, one of
  // the statement's duration columns - as the filing itself presents them.
  const durations = Object.values(used).filter((c) => !c.instant);
  const starts = new Set(durations.map((c) => prevDay(c.start!)));
  const ends = new Set(durations.map((c) => c.end!));
  for (const item of lineItems) {
    const pl = item.preferredLabel || '';
    const want = /periodStart/i.test(pl) ? starts : /periodEnd/i.test(pl) ? ends : null;
    if (!want || !durations.length) continue;
    item.values = Object.fromEntries(Object.entries(item.values).filter(([id]) => !used[id]?.instant || want.has(used[id]!.instant!)));
    if (item.labelZh) item.labelZh += want === starts ? '（期初）' : '（期末）';
  }

  const counts: Record<string, number> = Object.fromEntries(Object.keys(used).map((id) => [id, 0]));
  for (const item of lineItems) for (const id of Object.keys(item.values)) counts[id]!++;
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
    columns: columns.map((c): StatementColumn => ({
      id: c.id,
      period: c.instant ? { instant: c.instant } : { start: c.start!, end: c.end! },
      dimensions: c.dimensions,
    })),
    lineItems,
  };
}

/** The primary slots plus every statement the filing presents. */
export interface BuiltStatements {
  statements: PrimaryStatements;
  allStatements: Statement[];
}

export function buildStatements(doc: XbrlDoc, tax: Taxonomy, concepts: Record<Concept, ConceptMeta> = {}): BuiltStatements {
  const byName = factsByName(doc);
  const roles = Object.values(tax.roles)
    .filter((r) => r.kind.toLowerCase() === 'statement' && r.roots.length)
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const all = roles.map((r) => buildStatement(r, doc, tax, byName, concepts));

  return { statements: pickPrimary(all), allStatements: all };
}

