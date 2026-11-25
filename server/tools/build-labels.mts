// Build server/data/labels.json, the row label -> concept dictionary a
// prospectus is read with (server/lib/rowLabels.ts), from the statements of
// the saved filings: one filing per company, so a label's count is how many
// companies use it and no filer outvotes the rest.
//   node server/tools/build-labels.mts [--check]
// --check holds every fifth company out of the dictionary and reports how
// often it names their rows right, instead of writing the file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, store } from '../lib/store.ts';
import { C } from '../lib/concepts.ts';
import { reclassify } from '../lib/statementTypes.ts';
import { firstSection, lookupLabel, normLabel, packEntry, sectionOf } from '../lib/rowLabels.ts';
import type { LabelFile, LabelledType } from '../lib/rowLabels.ts';
import type { Concept } from '../lib/types.ts';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'labels.json');
const CHECK = process.argv.includes('--check');
const MIN_COMPANIES = 4; // a label fewer companies use is somebody's own wording
const MIN_SHARE = 0.5; // the concept has to be what most of them mean by it
const TAXONOMIES = ['us-gaap', 'ifrs-full'];
const TYPES: LabelledType[] = ['balance_sheet', 'income_statement', 'cash_flow'];

/** How one label was tagged: by how many companies, and with what signs. */
interface Tally {
  n: number;
  negated: number;
  values: number;
  positive: number;
}
/** A row of a held-out filing. */
interface Row {
  type: LabelledType;
  key: string;
  label: string;
  taxonomy: string;
  concept: Concept;
}

openStore();
const newest = new Map<number, ReturnType<typeof store.allFilings>[number]>();
for (const f of store.allFilings()) if ((newest.get(f.cik)?.reportDate || '') < (f.reportDate || '')) newest.set(f.cik, f);

const tallies = new Map<string, Map<string, Tally>>(); // `<taxonomy>|<type>|<section>|<label>` -> concept name -> tally
const signs = new Map<string, Tally>(); // concept, over every label it goes by
const held: Row[] = [];
let filings = 0;
for (const f of newest.values()) {
  const saved = store.getFiling(f.accession);
  if (!saved || saved.filing.source) continue; // a rebuild's labels are not the filer's own rows
  const data = reclassify(saved);
  filings++;
  for (const type of TYPES) {
    const st = data.statements[type];
    if (!st) continue;
    const plain = new Set(st.columns.filter((c) => !Object.keys(c.dimensions).length).map((c) => c.id));
    let at = firstSection(type);
    for (const li of st.lineItems) {
      const label = normLabel(li.label);
      const [section, next] = sectionOf(type, at, label);
      at = next;
      if (li.abstract || !label) continue;
      const values = Object.entries(li.values).filter(([id, v]) => plain.has(id) && typeof v.value === 'number').map(([, v]) => v.value as number);
      if (!values.length) continue;
      const [taxonomy, name] = li.concept.split(':') as [string, string];
      const key = `${type}|${section}|${label}`;
      if (CHECK && f.cik % 5 === 0) {
        held.push({ type, key, label, taxonomy, concept: li.concept });
        continue;
      }
      const add = (into: Map<string, Tally>, k: string) => {
        const t = into.get(k) || into.set(k, { n: 0, negated: 0, values: 0, positive: 0 }).get(k)!;
        t.n++;
        if (li.negated) t.negated++;
        for (const v of values) if (v) t.values++;
        for (const v of values) if (v > 0) t.positive++;
      };
      // the filer's own extensions count towards the total (a label that is
      // usually an extension must not look like a standard concept) under the
      // taxonomy the filing is in
      const own = TAXONOMIES.includes(taxonomy) ? taxonomy : data.statements.balance_sheet?.lineItems.some((x) => x.concept.startsWith('ifrs-full:')) ? 'ifrs-full' : 'us-gaap';
      for (const k of [`${own}|${key}`, `${own}|${type}||${label}`]) add(tallies.get(k) || tallies.set(k, new Map()).get(k)!, own === taxonomy ? name : `${taxonomy}:${name}`);
      add(signs, li.concept);
    }
  }
}

const dict: LabelFile = Object.fromEntries(TAXONOMIES.map((t) => [t, {}]));
for (const [k, by] of [...tallies].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const total = [...by.values()].reduce((s, t) => s + t.n, 0);
  const [name, t] = [...by].sort((a, b) => b[1].n - a[1].n)[0]!;
  if (t.n < MIN_COMPANIES || t.n / total < MIN_SHARE || name.includes(':')) continue;
  const taxonomy = k.slice(0, k.indexOf('|'));
  const sign = signs.get(`${taxonomy}:${name}`)!;
  dict[taxonomy]![k.slice(taxonomy.length + 1)] = packEntry(name, t.negated / t.n > 0.7, sign.values >= 20 && sign.positive / sign.values >= 0.95);
}
// a section's own entry that only repeats the statement-wide one is not needed
for (const own of Object.values(dict)) {
  for (const [k, v] of Object.entries(own)) {
    const [type, section, label] = k.split('|');
    if (section && own[`${type}||${label}`] === v) delete own[k];
  }
}
const size = TAXONOMIES.map((t) => `${t} ${Object.keys(dict[t]!).length}`).join(', ');

if (CHECK) {
  const groupOf = new Map<Concept, string>();
  for (const [g, list] of Object.entries(C)) for (const c of list) if (!groupOf.has(c)) groupOf.set(c, g);
  let named = 0;
  let right = 0;
  let same = 0;
  for (const r of held) {
    const [, section] = r.key.split('|') as [string, never];
    const e = TAXONOMIES.includes(r.taxonomy) ? lookupLabel(dict, r.taxonomy, r.type, section, r.label) : lookupLabel(dict, 'us-gaap', r.type, section, r.label);
    if (!e) continue;
    named++;
    if (e.concept === r.concept) right++;
    if (e.concept === r.concept || (groupOf.has(e.concept) && groupOf.get(e.concept) === groupOf.get(r.concept))) same++;
  }
  const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;
  console.log(`build-labels: ${filings} filings, dictionary ${size}; of ${held.length} held-out rows ${pct(named, held.length)} named, ${pct(right, named)} with the filer's own concept, ${pct(same, named)} with it or an interchangeable one`);
} else {
  // a line per entry, so a rebuild is a readable diff
  const body = TAXONOMIES.map((t) => `${JSON.stringify(t)}: {\n${Object.entries(dict[t]!).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}`).join(',\n');
  fs.writeFileSync(OUT, `{\n${body}\n}\n`);
  console.log(`build-labels: ${filings} filings -> ${path.relative(process.cwd(), OUT)} (${size}, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}
process.exit(0);
