// Extension taxonomy: role titles (.xsd), presentation tree (_pre.xml) and
// labels (_lab.xml). Some filing agents embed the linkbases inside the .xsd.

import { loadXml, prefixMap, tag } from './ixbrl.ts';
import type { Dom } from './ixbrl.ts';
import type { Concept, LabelIndex, Taxonomy, TaxonomyFiles, TaxonomyNode, TaxonomyRole } from './types.ts';

/** Anything that can fetch a linkbase next to the filing. */
export interface TextFetcher {
  text(url: string): Promise<string>;
}

export const STANDARD_LABEL = 'http://www.xbrl.org/2003/role/label';
const TERSE_LABEL = 'http://www.xbrl.org/2003/role/terseLabel';

// 'https://.../us-gaap-2025.xsd#us-gaap_Assets' -> 'us-gaap:Assets'
export function conceptFromHref(href: string): Concept {
  const frag = href.split('#').pop()!;
  const i = frag.indexOf('_');
  return i > 0 ? `${frag.slice(0, i)}:${frag.slice(i + 1)}` : frag;
}

export function roleInfo(definition: string): Pick<TaxonomyRole, 'sortKey' | 'kind' | 'title'> {
  const parts = definition.split(' - ');
  if (parts.length >= 3) {
    return { sortKey: parts[0]!.trim(), kind: parts[1]!.trim(), title: parts.slice(2).join(' - ').trim() };
  }
  return { sortKey: definition, kind: '', title: definition.trim() };
}

/** A loaded linkbase with the selectors its prefixes need. */
interface Loaded {
  $: Dom;
  t: (canon: string, local: string) => string;
  x: (local: string) => string;
}

function load(data: string | Dom): Loaded {
  const $ = typeof data === 'string' ? loadXml(data) : data;
  const p = prefixMap($);
  // Some agents (Toppan Merrill) declare the prefix on the root but write the
  // children in a default namespace (<presentationLink xmlns="...linkbase">),
  // others declare the namespace twice (xmlns="…linkbase" and xmlns:link),
  // so match the element under every declared prefix and bare.
  const t = (canon: string, local: string) => [...new Set([...(p.all?.[canon] || [p[canon] as string]).filter(Boolean).map((pre) => tag(pre, local)), local])].join(', ');
  return { $, t, x: (local: string) => (p.xlink ? `${p.xlink as string}:${local}` : local) };
}

/** What the extension .xsd yields: the roles, and where the linkbases are. */
export interface ParsedSchema {
  $: Dom;
  roles: Record<string, TaxonomyRole>;
  linkbases: Record<string, string>;
}

export function parseSchema(data: string | Dom): ParsedSchema {
  const { $, t } = load(data);
  const roles: Record<string, TaxonomyRole> = {};
  $(t('link', 'roleType')).each((_, el) => {
    const uri = $(el).attr('roleURI')!;
    const definition = $(el).children(t('link', 'definition')).first().text().trim();
    roles[uri] = { uri, definition, ...roleInfo(definition), roots: [] };
  });
  const linkbases: Record<string, string> = {};
  $(t('link', 'linkbaseRef')).each((_, el) => {
    const href = $(el).attr(`${prefixMap($).xlink as string}:href`) || '';
    const role = $(el).attr(`${prefixMap($).xlink as string}:role`) || '';
    const m = /\/(presentation|label|calculation|definition)LinkbaseRef$/.exec(role);
    if (m) linkbases[m[1]!.slice(0, 3)] = href;
    else {
      const f = /_(pre|lab|cal|def)\.xml$/.exec(href);
      if (f) linkbases[f[1]!] = href;
    }
  });
  return { $, roles, linkbases };
}

export function parsePresentation(data: string | Dom, roles: Record<string, TaxonomyRole>): void {
  const { $, t, x } = load(data);
  $(t('link', 'presentationLink')).each((_, plink) => {
    const uri = $(plink).attr(x('role'))!;
    if (!roles[uri]) roles[uri] = { uri, definition: uri, ...roleInfo(uri), roots: [] };
    const role = roles[uri]!;
    const locs: Record<string, Concept> = {};
    $(plink).children(t('link', 'loc')).each((_, loc) => {
      locs[$(loc).attr(x('label'))!] = conceptFromHref($(loc).attr(x('href')) || '');
    });
    const nodes: Record<string, TaxonomyNode> = {};
    const childrenOf: Record<string, TaxonomyNode[]> = {};
    const hasParent = new Set<string>();
    $(plink).children(t('link', 'presentationArc')).each((_, arc) => {
      const a = (arc as import('domhandler').Element).attribs;
      if (a.use === 'prohibited') return;
      const from = a[x('from')];
      const to = a[x('to')];
      if (!(from in locs) || !(to in locs)) return;
      const node: TaxonomyNode = { concept: locs[to]!, order: Number(a.order || 0), preferredLabel: a.preferredLabel || null, children: [] };
      nodes[to] = node;
      (childrenOf[from] ||= []).push(node);
      hasParent.add(to);
    });
    for (const [label, kids] of Object.entries(childrenOf)) {
      kids.sort((m, n) => m.order - n.order);
      if (nodes[label]) nodes[label]!.children = kids;
    }
    role.roots = Object.keys(locs)
      .filter((label) => childrenOf[label] && !hasParent.has(label))
      .map((label) => ({ concept: locs[label]!, order: 0, preferredLabel: null, children: childrenOf[label]! }));
  });
}

export function parseLabels(data: string | Dom): LabelIndex {
  const { $, t, x } = load(data);
  const labels: LabelIndex = {};
  $(t('link', 'labelLink')).each((_, llink) => {
    const locs: Record<string, Concept> = {};
    $(llink).children(t('link', 'loc')).each((_, loc) => {
      locs[$(loc).attr(x('label'))!] = conceptFromHref($(loc).attr(x('href')) || '');
    });
    const texts: Record<string, [string, string][]> = {};
    $(llink).children(t('link', 'label')).each((_, lab) => {
      const key = $(lab).attr(x('label'))!;
      (texts[key] ||= []).push([$(lab).attr(x('role')) || STANDARD_LABEL, $(lab).text().replace(/\s+/g, ' ').trim()]);
    });
    $(llink).children(t('link', 'labelArc')).each((_, arc) => {
      const attribs = (arc as import('domhandler').Element).attribs;
      const concept = locs[attribs[x('from')]!];
      if (!concept) return;
      for (const [role, text] of texts[attribs[x('to')]!] || []) (labels[concept] ||= {})[role] = text;
    });
  });
  return labels;
}

export function labelFor(labels: LabelIndex, concept: Concept, preferred: string | null | undefined): string | null {
  const table = labels[concept] || {};
  for (const role of [preferred, STANDARD_LABEL, TERSE_LABEL]) if (role && table[role]) return table[role]!;
  const any = Object.values(table);
  return any.length ? any[0]! : null;
}

export async function loadTaxonomy(client: TextFetcher, folderUrl: string, schemaRef: string | null, folderFiles: readonly string[]): Promise<Taxonomy> {
  const pick = (suffix: string) => folderFiles.find((f) => f.endsWith(suffix)) || null;
  const xsdName = schemaRef && !/^https?:/.test(schemaRef) ? schemaRef : pick('.xsd');
  if (!xsdName) throw new Error('Filing has no extension schema (.xsd); cannot lay out statements.');
  const files: TaxonomyFiles = { xsd: xsdName };
  const { $: xsd, roles, linkbases } = parseSchema(await client.text(`${folderUrl}/${xsdName}`));
  const { t } = load(xsd);

  if (xsd(t('link', 'presentationLink')).length) {
    parsePresentation(xsd, roles);
    files.pre = xsdName;
  } else {
    const preName = linkbases.pre || pick('_pre.xml');
    if (!preName) throw new Error('Filing has no presentation linkbase (_pre.xml); cannot lay out statements.');
    parsePresentation(await client.text(`${folderUrl}/${preName}`), roles);
    files.pre = preName;
  }

  let labels: LabelIndex = {};
  if (xsd(t('link', 'labelLink')).length) {
    labels = parseLabels(xsd);
    files.lab = xsdName;
  } else {
    const labName = linkbases.lab || pick('_lab.xml');
    if (labName) labels = parseLabels(await client.text(`${folderUrl}/${labName}`));
    files.lab = labName;
  }
  return { roles, labels, files };
}
