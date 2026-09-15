// Extension taxonomy: role titles (.xsd), presentation tree (_pre.xml) and
// labels (_lab.xml). Some filing agents embed the linkbases inside the .xsd.

import { loadXml, prefixMap, tag } from './ixbrl.js';

export const STANDARD_LABEL = 'http://www.xbrl.org/2003/role/label';
const TERSE_LABEL = 'http://www.xbrl.org/2003/role/terseLabel';

// 'https://.../us-gaap-2025.xsd#us-gaap_Assets' -> 'us-gaap:Assets'
export function conceptFromHref(href) {
  const frag = href.split('#').pop();
  const i = frag.indexOf('_');
  return i > 0 ? `${frag.slice(0, i)}:${frag.slice(i + 1)}` : frag;
}

export function roleInfo(definition) {
  const parts = definition.split(' - ');
  if (parts.length >= 3) {
    return { sortKey: parts[0].trim(), kind: parts[1].trim(), title: parts.slice(2).join(' - ').trim() };
  }
  return { sortKey: definition, kind: '', title: definition.trim() };
}

function load(data) {
  const $ = typeof data === 'string' ? loadXml(data) : data;
  const p = prefixMap($);
  return { $, t: (canon, local) => tag(p[canon], local), x: (local) => (p.xlink ? `${p.xlink}:${local}` : local) };
}

export function parseSchema(data) {
  const { $, t } = load(data);
  const roles = {};
  $(t('link', 'roleType')).each((_, el) => {
    const uri = $(el).attr('roleURI');
    const definition = $(el).children(t('link', 'definition')).first().text().trim();
    roles[uri] = { uri, definition, ...roleInfo(definition), roots: [] };
  });
  const linkbases = {};
  $(t('link', 'linkbaseRef')).each((_, el) => {
    const href = $(el).attr(`${prefixMap($).xlink}:href`) || '';
    const role = $(el).attr(`${prefixMap($).xlink}:role`) || '';
    const m = /\/(presentation|label|calculation|definition)LinkbaseRef$/.exec(role);
    if (m) linkbases[m[1].slice(0, 3)] = href;
    else {
      const f = /_(pre|lab|cal|def)\.xml$/.exec(href);
      if (f) linkbases[f[1]] = href;
    }
  });
  return { $, roles, linkbases };
}

export function parsePresentation(data, roles) {
  const { $, t, x } = load(data);
  $(t('link', 'presentationLink')).each((_, plink) => {
    const uri = $(plink).attr(x('role'));
    if (!roles[uri]) roles[uri] = { uri, definition: uri, ...roleInfo(uri), roots: [] };
    const role = roles[uri];
    const locs = {};
    $(plink).children(t('link', 'loc')).each((_, loc) => {
      locs[$(loc).attr(x('label'))] = conceptFromHref($(loc).attr(x('href')) || '');
    });
    const nodes = {};
    const childrenOf = {};
    const hasParent = new Set();
    $(plink).children(t('link', 'presentationArc')).each((_, arc) => {
      const a = arc.attribs;
      if (a.use === 'prohibited') return;
      const from = a[x('from')];
      const to = a[x('to')];
      if (!(from in locs) || !(to in locs)) return;
      const node = { concept: locs[to], order: Number(a.order || 0), preferredLabel: a.preferredLabel || null, children: [] };
      nodes[to] = node;
      (childrenOf[from] ||= []).push(node);
      hasParent.add(to);
    });
    for (const [label, kids] of Object.entries(childrenOf)) {
      kids.sort((m, n) => m.order - n.order);
      if (nodes[label]) nodes[label].children = kids;
    }
    role.roots = Object.keys(locs)
      .filter((label) => childrenOf[label] && !hasParent.has(label))
      .map((label) => ({ concept: locs[label], order: 0, preferredLabel: null, children: childrenOf[label] }));
  });
}

export function parseLabels(data) {
  const { $, t, x } = load(data);
  const labels = {};
  $(t('link', 'labelLink')).each((_, llink) => {
    const locs = {};
    $(llink).children(t('link', 'loc')).each((_, loc) => {
      locs[$(loc).attr(x('label'))] = conceptFromHref($(loc).attr(x('href')) || '');
    });
    const texts = {};
    $(llink).children(t('link', 'label')).each((_, lab) => {
      const key = $(lab).attr(x('label'));
      (texts[key] ||= []).push([$(lab).attr(x('role')) || STANDARD_LABEL, $(lab).text().replace(/\s+/g, ' ').trim()]);
    });
    $(llink).children(t('link', 'labelArc')).each((_, arc) => {
      const concept = locs[arc.attribs[x('from')]];
      if (!concept) return;
      for (const [role, text] of texts[arc.attribs[x('to')]] || []) (labels[concept] ||= {})[role] = text;
    });
  });
  return labels;
}

export function labelFor(labels, concept, preferred) {
  const table = labels[concept] || {};
  for (const role of [preferred, STANDARD_LABEL, TERSE_LABEL]) if (role && table[role]) return table[role];
  const any = Object.values(table);
  return any.length ? any[0] : null;
}

export async function loadTaxonomy(client, folderUrl, schemaRef, folderFiles) {
  const pick = (suffix) => folderFiles.find((f) => f.endsWith(suffix)) || null;
  const xsdName = schemaRef && !/^https?:/.test(schemaRef) ? schemaRef : pick('.xsd');
  if (!xsdName) throw new Error('Filing has no extension schema (.xsd); cannot lay out statements.');
  const files = { xsd: xsdName };
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

  let labels = {};
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
