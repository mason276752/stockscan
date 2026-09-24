// SIC codes (with Chinese names) and filer-status categories - data only,
// usable from the browser build as well as the server.

import SIC_DATA from '../data/sic.json' with { type: 'json' };

export const SIC = SIC_DATA;
const SIC_BY_CODE = new Map(SIC.codes.map((c) => [c.code, c]));

export const FILER_STATUS = {
  LAF: { label: 'Large accelerated filer', zh: '大型加速申報公司', note: '公眾流通市值 ≥ 7 億美元' },
  ACC: { label: 'Accelerated filer', zh: '加速申報公司', note: '公眾流通市值 7,500 萬 ～ 7 億美元' },
  NON: { label: 'Non-accelerated filer', zh: '非加速申報公司', note: '公眾流通市值 < 7,500 萬美元，或年營收 < 1 億美元的小型申報公司' },
};

export function sicInfo(code) {
  if (!code) return null;
  const c = String(code).padStart(4, '0');
  const hit = SIC_BY_CODE.get(c);
  return hit || { code: c, title: null, zh: null, division: null, office: null };
}

