// Interactive Brokers TWS API (via @stoqey/ib): daily bars for the custom-ETF
// charts. Needs TWS or IB Gateway running with "Enable ActiveX and Socket
// Clients" ticked; the socket port is 7496 (TWS live), 7497 (TWS paper),
// 4001 / 4002 (Gateway live / paper). Configure with IB_HOST, IB_PORT,
// IB_CLIENT_ID; IB_ENABLED=0 turns it off. Nothing here places orders or
// touches the account - only reqHistoricalData.

import { BarSizeSetting, ConnectionState, IBApiNext, LogLevel, SecType, WhatToShow } from '@stoqey/ib';

export const IB = {
  enabled: !/^(0|false|no|off)$/i.test(process.env.IB_ENABLED || '1'),
  host: process.env.IB_HOST || '127.0.0.1',
  port: Number(process.env.IB_PORT || 7496),
  clientId: Number(process.env.IB_CLIENT_ID || 100 + (Number(process.env.PORT || 3000) % 1000)),
};

let api = null;
let state = 'disconnected'; // disconnected | connecting | connected
let lastError = null;
let connectedAt = null;
let requests = 0;
let waiters = [];

function ensureApi() {
  if (api) return api;
  api = new IBApiNext({ host: IB.host, port: IB.port, reconnectInterval: 30_000, connectionWatchdogInterval: 0 });
  api.logLevel = LogLevel.SYSTEM; // TWS chatter (farm connections etc.) is not interesting
  api.connectionState.subscribe((s) => {
    const prev = state;
    state = s === ConnectionState.Connected ? 'connected' : s === ConnectionState.Connecting ? 'connecting' : 'disconnected';
    if (state === 'connected') {
      connectedAt = new Date().toISOString();
      lastError = null;
      if (prev !== 'connected') console.log(`ibkr: connected to ${IB.host}:${IB.port} (client ${IB.clientId})`);
      for (const w of waiters.splice(0)) w(true);
    } else if (prev === 'connected') console.log('ibkr: disconnected');
  });
  api.error.subscribe((e) => {
    // -1 / 502 / 504: connection problems; everything else is per request
    if (e.reqId === -1 || e.code === 502 || e.code === 504) lastError = e.error?.message || String(e.error);
  });
  return api;
}

export const ibConnected = () => state === 'connected';

export function ibStatus() {
  return { enabled: IB.enabled, host: IB.host, port: IB.port, clientId: IB.clientId, state, connected: ibConnected(), connectedAt, lastError, requests };
}

// Connect (or wait for the auto-reconnect) for up to timeoutMs; resolves to
// whether TWS is reachable. Safe to call repeatedly - the UI's retry button
// does.
export function ibConnect(timeoutMs = 4000) {
  if (!IB.enabled) return Promise.resolve(false);
  const a = ensureApi();
  if (state === 'connected') return Promise.resolve(true);
  if (state === 'disconnected') {
    try {
      a.connect(IB.clientId);
    } catch (err) {
      lastError = err.message;
      return Promise.resolve(false);
    }
  }
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      waiters = waiters.filter((w) => w !== done);
      resolve(state === 'connected');
    }, timeoutMs);
    const done = (ok) => {
      clearTimeout(t);
      resolve(ok);
    };
    waiters.push(done);
  });
}

export function ibDisconnect() {
  if (api && state !== 'disconnected') api.disconnect();
}

// IB writes share classes with a space (BRK B) where EDGAR uses "-" / "." (BRK-B).
export const ibSymbol = (ticker) => String(ticker).toUpperCase().replace(/[-.]/g, ' ');

// EDGAR's ticker table carries no exchange: an ambiguous symbol (the same
// ticker on several IB exchanges) is retried with these primary exchanges.
const PRIMARY = ['NASDAQ', 'NYSE', 'ARCA', 'AMEX'];

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: TWS did not answer within ${ms / 1000}s`)), ms).unref())]);

// Daily OHLC bars (split-adjusted, TWS "TRADES"), oldest first:
// [{ date, open, high, low, close, volume }]
export async function ibDailyBars(ticker, { years = 10 } = {}) {
  if (!(await ibConnect(2000))) throw Object.assign(new Error('IBKR TWS is not connected'), { status: 503 });
  const contract = { symbol: ibSymbol(ticker), secType: SecType.STK, exchange: 'SMART', currency: 'USD' };
  const ask = async (c) => {
    requests++;
    return withTimeout(api.getHistoricalData(c, '', `${years} Y`, BarSizeSetting.DAYS_ONE, WhatToShow.TRADES, 1, 1), 45_000, ticker);
  };
  let bars;
  const tries = [contract, ...PRIMARY.map((primaryExch) => ({ ...contract, primaryExch }))];
  for (let i = 0; i < tries.length; i++) {
    try {
      bars = await ask(tries[i]);
      break;
    } catch (err) {
      const msg = err?.error?.message || err?.message || String(err);
      if (/ambiguous/i.test(msg) && i < tries.length - 1) continue;
      throw Object.assign(new Error(`IBKR: ${msg}`), { status: /no security definition|ambiguous/i.test(msg) ? 404 : 502 });
    }
  }
  const days = [];
  for (const b of bars || []) {
    // formatDate 1 gives yyyymmdd for daily bars
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(b.time || ''));
    if (!m || typeof b.close !== 'number' || b.close <= 0) continue;
    days.push({ date: `${m[1]}-${m[2]}-${m[3]}`, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? null });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
}
