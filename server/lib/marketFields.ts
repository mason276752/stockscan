// The market-snapshot fields the screener offers (shared with the browser build).

/** A screener column the market snapshot fills in. */
export interface MarketField {
  key: string;
  name: string;
  unit: string;
  group: string;
}

// the screener fields the snapshot provides (unit as shown to the user)
export const MARKET_FIELDS: MarketField[] = [
  { key: 'price', name: '股價', unit: '美元', group: '市場' },
  { key: 'marketCap', name: '總市值', unit: '百萬', group: '市場' },
  { key: 'change', name: '今日漲跌 %', unit: '%', group: '市場' },
  { key: 'perfYtd', name: '今年以來漲跌 %', unit: '%', group: '市場' },
  { key: 'perfY', name: '一年漲跌 %', unit: '%', group: '市場' },
  { key: 'volume', name: '今日成交量', unit: '股', group: '市場' },
  { key: 'avgVolume', name: '30 日均量', unit: '股', group: '市場' },
  { key: 'beta', name: 'Beta（1 年）', unit: '', group: '市場' },
  { key: 'pe', name: '本益比 P/E（近四季）', unit: '倍', group: '股價估值' },
  { key: 'pb', name: '股價淨值比 P/B', unit: '倍', group: '股價估值' },
  { key: 'ps', name: '股價營收比 P/S', unit: '倍', group: '股價估值' },
  { key: 'pfcf', name: '股價自由現金流比 P/FCF', unit: '倍', group: '股價估值' },
  { key: 'evEbitda', name: 'EV / EBITDA', unit: '倍', group: '股價估值' },
  { key: 'peg', name: 'PEG', unit: '', group: '股價估值' },
  { key: 'divYield', name: '現金股利殖利率 %', unit: '%', group: '股價估值' },
];
