// Parse an Inline XBRL document into contexts, units and facts.

import * as cheerio from 'cheerio';

export const NS = {
  ix: 'http://www.xbrl.org/2013/inlineXBRL',
  xbrli: 'http://www.xbrl.org/2003/instance',
  xbrldi: 'http://xbrl.org/2006/xbrldi',
  link: 'http://www.xbrl.org/2003/linkbase',
  xlink: 'http://www.w3.org/1999/xlink',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
};

export function loadXml(text) {
  return cheerio.load(text, { xml: true });
}

// Map our canonical prefixes (ix, xbrli, ...) to whatever prefix the document
// actually declares for that namespace URI.
export function prefixMap($) {
  const attrs = $.root().children().first().attr() || {};
  const byUri = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('xmlns:')) (byUri[v] ||= []).push(k.slice(6));
    else if (k === 'xmlns') (byUri[v] ||= []).push(''); // default namespace: unprefixed tags
  }
  const map = { all: {} };
  for (const [canon, uri] of Object.entries(NS)) {
    const prefixes = byUri[uri] || [canon];
    // prefer a real prefix over the default namespace when both are declared
    map[canon] = prefixes.find((x) => x) ?? prefixes[0];
    map.all[canon] = prefixes;
  }
  return map;
}

// A document that declares two prefixes for one namespace (xmlns:i and
// xmlns:xbrli both for the instance namespace, contexts written as
// <i:context>) is rewritten so every element uses the first prefix, which is
// the one the selectors are built from.
export function unifyPrefixes(text) {
  const head = /<html[^>]*>/i.exec(text)?.[0] || text.slice(0, 4000);
  const byUri = {};
  for (const m of head.matchAll(/xmlns:([A-Za-z0-9_.-]+)="([^"]+)"/g)) (byUri[m[2]] ||= []).push(m[1]);
  let out = text;
  for (const uri of Object.values(NS)) {
    const prefixes = byUri[uri];
    if (!prefixes || prefixes.length < 2) continue;
    const [keep, ...aliases] = prefixes;
    for (const a of aliases) out = out.replace(new RegExp(`<(\\/?)${a}:`, 'g'), `<$1${keep}:`);
  }
  return out;
}

export const tag = (prefix, local) => (prefix ? `${prefix}\\:${local}` : local);

const WORD_NUMBERS = {
  no: 0, none: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12,
};

function wordsToNumber(text) {
  let total = 0;
  let current = 0;
  let found = false;
  for (let w of text.toLowerCase().split(/[\s-]+/)) {
    w = w.replace(/[,.]/g, '');
    if (w === '' || w === 'and') continue;
    if (!(w in WORD_NUMBERS)) return null;
    found = true;
    const n = WORD_NUMBERS[w];
    if (n === 100) current = (current || 1) * 100;
    else if (n >= 1000) {
      total += (current || 1) * n;
      current = 0;
    } else current += n;
  }
  return found ? String(total + current) : null;
}

// Displayed text of an ix:nonFraction -> canonical decimal string (no scale/sign yet).
export function parseNumber(raw, format) {
  const text = raw.trim();
  const local = (format || '').split(':').pop().toLowerCase();
  if (['fixed-zero', 'fixedzero', 'zerodash', 'numdash', 'num-dash'].includes(local)) return '0';
  if (local === 'numwordsen' || local === 'num-words-en') return wordsToNumber(text);
  if (text === '') return null;
  if (['-', '—', '–'].includes(text)) return '0';
  let s;
  if (local.includes('comma-decimal') || local === 'numcommadecimal') {
    s = text.replace(/[.\s ]/g, '').replace(/,/g, '.');
  } else {
    s = text.replace(/[,\s ]/g, '');
  }
  s = s.replace('(', '-').replace(')', '');
  return /^-?\d*\.?\d+$/.test(s) || /^-?\d+\.?$/.test(s) ? s : null;
}

// Shift the decimal point of a decimal string by `scale` places without going
// through floating point, then negate if sign="-".
export function finalizeNumber(dec, scale, sign) {
  if (dec == null) return null;
  let neg = dec.startsWith('-');
  if (neg) dec = dec.slice(1);
  let [int, frac = ''] = dec.split('.');
  int = int.replace(/^0+(?=\d)/, '') || '0';
  const shift = Number(scale || 0);
  let digits = int + frac;
  let point = int.length + shift;
  let out;
  if (point >= digits.length) out = digits.padEnd(point, '0');
  else if (point <= 0) out = '0.' + '0'.repeat(-point) + digits;
  else out = digits.slice(0, point) + '.' + digits.slice(point);
  out = out.replace(/^0+(?=\d)/, '');
  if (out.includes('.')) out = out.replace(/\.?0+$/, '');
  if (sign === '-') neg = !neg;
  const n = Number(out);
  return n === 0 ? 0 : neg ? -n : n;
}

const DATE_PATTERNS = {
  'monthname-day-year': [/^([A-Za-z]+) (\d{1,2}),? (\d{4})$/, (m) => [m[3], monthNum(m[1]), m[2]]],
  'day-monthname-year': [/^(\d{1,2}) ([A-Za-z]+),? (\d{4})$/, (m) => [m[3], monthNum(m[2]), m[1]]],
  'month-day-year': [/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/, (m) => [m[3], m[1], m[2]]],
  'day-month-year': [/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/, (m) => [m[3], m[2], m[1]]],
  'year-month-day': [/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/, (m) => [m[1], m[2], m[3]]],
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function monthNum(name) {
  const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
}

// Common ixt transforms for ix:nonNumeric (booleans, dates).
export function transformText(raw, format) {
  const local = (format || '').split(':').pop().toLowerCase();
  if (local === 'fixed-true' || local === 'booleantrue') return 'true';
  if (local === 'fixed-false' || local === 'booleanfalse') return 'false';
  if (local.startsWith('date')) {
    const text = raw.replace(/\./g, '').replace(/\s+/g, ' ').trim();
    const keys = Object.keys(DATE_PATTERNS).filter((k) => local.includes(k));
    for (const key of keys.length ? keys : Object.keys(DATE_PATTERNS)) {
      const [re, pick] = DATE_PATTERNS[key];
      const m = re.exec(text);
      if (!m) continue;
      const [y, mo, d] = pick(m);
      if (!mo || Number(mo) > 12 || Number(d) > 31) continue;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return raw;
}

function textWithoutExcludes($, el, excludeTag) {
  const node = $(el);
  if (node.find(excludeTag).length === 0) return node.text();
  const clone = node.clone();
  clone.find(excludeTag).remove();
  return clone.text();
}

function measureName(m) {
  return (m || '').split(':').pop();
}

const COVER_SHARE_CONCEPTS = ['dei:EntityCommonStockSharesOutstanding', 'us-gaap:CommonStockSharesOutstanding'];
const CLASS_AXIS = /(?:class|share|stock).*(?:class|share|stock)|(?:class|share|stock)axis/i;
const TOTAL_MEMBER = /(?:total|aggregate)/i;

// Extract the shares on a filing cover while the raw facts still retain their
// contexts. A total needs to be whole-entity; when the cover lists classes
// separately (Alphabet A/B/C), add them only if one class axis is the sole
// difference. Ambiguity is deliberately omitted rather than guessed.
export function coverSharesOf({ contexts = {}, units = {}, facts = [] }) {
  const candidates = facts
    .filter((f) => COVER_SHARE_CONCEPTS.includes(f.name) && f.numeric && Number.isFinite(f.value) && f.value > 0 && units[f.unitRef] === 'shares')
    .map((f) => {
      const c = contexts[f.contextRef];
      const end = c?.instant || c?.end || null;
      return c?.entity && /^\d{4}-\d{2}-\d{2}$/.test(end || '') ? { fact: f, entity: c.entity, end, dims: c.dimensions || {} } : null;
    })
    .filter(Boolean);
  const byGroup = new Map();
  for (const x of candidates) {
    const key = `${x.fact.name}\u0000${x.entity}\u0000${x.end}`;
    const a = byGroup.get(key) || [];
    a.push(x);
    byGroup.set(key, a);
  }
  const picked = [];
  for (const xs of byGroup.values()) {
    const { name } = xs[0].fact;
    const aggregate = xs.filter((x) => Object.keys(x.dims).length === 0);
    const aggregateValues = [...new Set(aggregate.map((x) => x.fact.value))];
    if (aggregateValues.length === 1) {
      picked.push({ end: xs[0].end, entity: xs[0].entity, value: aggregateValues[0], concept: name, basis: 'aggregate', classes: 1 });
      continue;
    }
    // A conflicting undimensioned total must not fall through to class facts.
    if (aggregateValues.length > 1) continue;
    const byAxis = new Map();
    for (const x of xs) {
      const entries = Object.entries(x.dims);
      if (entries.length !== 1 || !CLASS_AXIS.test(entries[0][0]) || TOTAL_MEMBER.test(entries[0][1])) continue;
      const [axis, member] = entries[0];
      const a = byAxis.get(axis) || [];
      a.push({ ...x, member });
      byAxis.set(axis, a);
    }
    const sums = [];
    for (const [axis, members] of byAxis) {
      if (members.length < 2) continue;
      const seen = new Set();
      let total = 0;
      let bad = false;
      for (const x of members) {
        if (seen.has(x.member)) {
          bad = true;
          break;
        }
        seen.add(x.member);
        total += x.fact.value;
      }
      if (!bad) sums.push({ axis, total, classes: members.length });
    }
    // Multiple class axes are not proof that their totals mean the same thing.
    if (sums.length !== 1) continue;
    const sum = sums[0];
    picked.push({ end: xs[0].end, entity: xs[0].entity, value: sum.total, concept: name, basis: 'class-sum', classes: sum.classes });
  }
  // DEI is the filing-cover concept. Use US-GAAP only when DEI supplied no
  // safe record for the same entity/date.
  const out = [];
  for (const x of picked.sort((a, b) => a.end.localeCompare(b.end) || a.entity.localeCompare(b.entity))) {
    if (x.concept.startsWith('us-gaap:') && out.some((y) => y.end === x.end && y.entity === x.entity && y.concept.startsWith('dei:'))) continue;
    out.push(x);
  }
  return out;
}

function mergeCoverShares(docs) {
  const byKey = new Map();
  for (const x of docs.flatMap((d) => d.coverShares || [])) {
    const key = `${x.entity}\u0000${x.end}\u0000${x.concept}`;
    const a = byKey.get(key) || [];
    a.push(x);
    byKey.set(key, a);
  }
  const out = [];
  for (const xs of byKey.values()) {
    const values = [...new Set(xs.map((x) => x.value))];
    if (values.length !== 1) continue;
    out.push(xs.find((x) => x.basis === 'aggregate') || xs[0]);
  }
  return out.filter((x) => !(x.concept.startsWith('us-gaap:') && out.some((y) => y !== x && y.end === x.end && y.entity === x.entity && y.concept.startsWith('dei:'))));
}

export function parseInlineXbrl(text) {
  const $ = loadXml(unifyPrefixes(text));
  const p = prefixMap($);
  const t = (canon, local) => tag(p[canon], local);

  const contexts = {};
  $(t('xbrli', 'context')).each((_, el) => {
    const c = $(el);
    const ctx = {
      id: c.attr('id'),
      entity: c.find(t('xbrli', 'identifier')).first().text().trim() || null,
      instant: c.find(t('xbrli', 'instant')).first().text().trim() || null,
      start: c.find(t('xbrli', 'startDate')).first().text().trim() || null,
      end: c.find(t('xbrli', 'endDate')).first().text().trim() || null,
      dimensions: {},
    };
    c.find(t('xbrldi', 'explicitMember')).each((_, m) => {
      ctx.dimensions[$(m).attr('dimension')] = $(m).text().trim();
    });
    c.find(t('xbrldi', 'typedMember')).each((_, m) => {
      ctx.dimensions[$(m).attr('dimension')] = $(m).children().first().text().trim();
    });
    contexts[ctx.id] = ctx;
  });

  const units = {};
  $(t('xbrli', 'unit')).each((_, el) => {
    const u = $(el);
    const num = u.find(`${t('xbrli', 'unitNumerator')} > ${t('xbrli', 'measure')}`).map((_, m) => measureName($(m).text())).get();
    const den = u.find(`${t('xbrli', 'unitDenominator')} > ${t('xbrli', 'measure')}`).map((_, m) => measureName($(m).text())).get();
    if (num.length || den.length) units[u.attr('id')] = `${num.join('*')}/${den.join('*')}`;
    else units[u.attr('id')] = u.children(t('xbrli', 'measure')).map((_, m) => measureName($(m).text())).get().join('*');
  });

  const facts = [];
  const seen = new Set();
  const nilAttr = `${p.xsi}:nil`;
  const excludeTag = t('ix', 'exclude');
  $(`${t('ix', 'nonFraction')}, ${t('ix', 'nonNumeric')}`).each((_, el) => {
    const a = el.attribs;
    const name = a.name;
    const contextRef = a.contextRef;
    if (!name || !contextRef) return;
    const numeric = el.name.endsWith('nonFraction');
    const nil = a[nilAttr] === 'true' || a[nilAttr] === '1';
    const raw = nil ? '' : textWithoutExcludes($, el, excludeTag).replace(/\s+/g, ' ').trim();
    const key = `${name}|${contextRef}`;
    if (numeric && seen.has(key)) return; // same fact tagged twice; keep the first
    seen.add(key);
    let value = null;
    if (!nil) value = numeric ? finalizeNumber(parseNumber(raw, a.format), a.scale, a.sign) : transformText(raw, a.format);
    facts.push({
      id: a.id || null,
      name,
      contextRef,
      unitRef: a.unitRef || null,
      raw,
      value,
      numeric,
      decimals: a.decimals ?? null,
      scale: a.scale ?? null,
      sign: a.sign ?? null,
      format: a.format ?? null,
      nil,
    });
  });

  const schemaRef = $(t('link', 'schemaRef')).first().attr(`${p.xlink}:href`) || null;

  // Document metadata: prefer undimensioned (whole-entity) values.
  const dei = {};
  const deiFacts = facts.filter((f) => f.name.startsWith('dei:') && !f.numeric && f.value != null);
  deiFacts.sort((a, b) => dimCount(contexts, a) - dimCount(contexts, b));
  for (const f of deiFacts) if (!(f.name.slice(4) in dei)) dei[f.name.slice(4)] = f.value;

  return { contexts, units, facts, schemaRef, dei, coverShares: coverSharesOf({ contexts, units, facts }) };
}

// An Inline XBRL document set: a 10-K whose financial statements sit in a
// second file (clx-20260630.htm + clx-20260630_d2.htm) shares one set of
// contexts and units across the files. Merge the parsed documents; the
// first one is the primary (its dei and schemaRef win).
export function mergeInlineDocs(docs) {
  const [first, ...rest] = docs;
  if (!rest.length) return first;
  const out = { contexts: { ...first.contexts }, units: { ...first.units }, facts: [...first.facts], schemaRef: first.schemaRef, dei: { ...first.dei }, coverShares: mergeCoverShares(docs) };
  const seen = new Set(first.facts.filter((f) => f.numeric).map((f) => `${f.name}|${f.contextRef}`));
  for (const d of rest) {
    Object.assign(out.contexts, d.contexts);
    Object.assign(out.units, d.units);
    for (const f of d.facts) {
      const key = `${f.name}|${f.contextRef}`;
      if (f.numeric && seen.has(key)) continue;
      seen.add(key);
      out.facts.push(f);
    }
    out.schemaRef ||= d.schemaRef;
    for (const [k, v] of Object.entries(d.dei)) if (!(k in out.dei)) out.dei[k] = v;
  }
  return out;
}

function dimCount(contexts, f) {
  const ctx = contexts[f.contextRef];
  return ctx ? Object.keys(ctx.dimensions).length : 99;
}

export function factsByName(doc) {
  const out = new Map();
  for (const f of doc.facts) {
    if (!out.has(f.name)) out.set(f.name, []);
    out.get(f.name).push(f);
  }
  return out;
}
