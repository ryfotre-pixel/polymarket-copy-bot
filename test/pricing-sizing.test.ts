import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOrder } from '../src/executor.ts';
import { checkEntry, checkExit, roundToTick, sidePrices } from '../src/pricing.ts';
import { exitQty, floorToStep, sizeOrder } from '../src/sizing.ts';
import type { UsBbo } from '../src/types.ts';

// Real BBO for aec-nba-mia-lac-2026-11-04 (US: shortQuote 0.34 = 1 - bestBid 0.66).
const bbo: UsBbo = { marketSlug: 'aec-nba-mia-lac-2026-11-04', bestBid: { value: '0.6600' }, bestAsk: { value: '0.6700' }, state: 'MARKET_STATE_OPEN' };

test('side prices: SHORT is priced off the LONG bid/ask', () => {
  assert.deepEqual(sidePrices(bbo, 'LONG'), { buy: 0.67, sell: 0.66 });
  const s = sidePrices(bbo, 'SHORT');
  assert.ok(Math.abs(s.buy! - 0.34) < 1e-9);
  assert.ok(Math.abs(s.sell! - 0.33) < 1e-9);
});

test('entry guard: accept within slippage, limit = ask + 1 tick', () => {
  const g = checkEntry(bbo, 'LONG', 0.65, 0.03, 0.005);
  assert.ok(g.ok);
  if (g.ok) assert.equal(g.limitPrice, 0.675);
});

test('entry guard: limit never above whale price + max slippage', () => {
  const g = checkEntry(bbo, 'LONG', 0.64, 0.03, 0.01);
  assert.ok(g.ok);
  if (g.ok) assert.equal(g.limitPrice, 0.67); // ask 0.67 is exactly at the cap; no +1 tick
});

test('entry guard: reject when US is too expensive', () => {
  const g = checkEntry(bbo, 'LONG', 0.6, 0.03, 0.005);
  assert.equal(g.ok, false);
});

test('entry guard: reject no liquidity / closed market', () => {
  assert.equal(checkEntry({ marketSlug: 'x', bestBid: null, bestAsk: null, state: 'MARKET_STATE_OPEN' }, 'LONG', 0.5, 0.03, 0.01).ok, false);
  assert.equal(checkEntry({ ...bbo, state: 'MARKET_STATE_EXPIRED' }, 'LONG', 0.67, 0.03, 0.01).ok, false);
});

test('exit guard sells 1 tick under the bid', () => {
  const g = checkExit(bbo, 'SHORT', 0.01);
  assert.ok(g.ok);
  if (g.ok) assert.equal(g.limitPrice, 0.32);
});

test('order price is sent in LONG terms with the right intent', () => {
  const o = buildOrder({ usSlug: 'aec-x', side: 'SHORT', action: 'BUY', qty: 10, limitPrice: 0.345, tick: 0.005 });
  assert.equal(o.intent, 'ORDER_INTENT_BUY_SHORT');
  assert.equal(o.price?.value, '0.655');
  assert.equal(o.tif, 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL');
});

test('tick rounding has no float noise', () => {
  assert.equal(roundToTick(0.675000001, 0.005, 'up'), 0.675);
  assert.equal(roundToTick(0.1 + 0.2, 0.01, 'down'), 0.3);
  assert.equal(floorToStep(4.4999999, 0.01), 4.49);
});

const cfg = { SIZING_MODE: 'fixed_pct' as const, USER_BANKROLL_USD: 90, PCT_PER_TRADE: 0.05, WHALE_BANKROLL_USD: 50000, MIN_ORDER_USD: 1, MAX_ORDER_USD: 10 };

test('sizing: 5% of $90 = $4.50 at 0.675 -> 6.66 contracts', () => {
  const s = sizeOrder(cfg, 500, 0.675, 0.01, 0);
  assert.deepEqual(s, { ok: true, qty: 6.66, usd: 4.4955 });
});

test('sizing: whale_ratio is clamped to MAX_ORDER_USD', () => {
  const s = sizeOrder({ ...cfg, SIZING_MODE: 'whale_ratio' }, 20000, 0.5, 1, 0);
  assert.ok(s.ok);
  if (s.ok) assert.equal(s.qty, 20); // $36 clamped to $10 -> 20 contracts at 0.50
});

test('sizing: stops when the bankroll is used up', () => {
  assert.equal(sizeOrder(cfg, 500, 0.5, 0.01, 89.5).ok, false);
  const s = sizeOrder(cfg, 500, 0.5, 0.01, 88); // only $2 free
  assert.ok(s.ok && s.qty === 4);
});

test('exits are proportional, full when the whale dumps (almost) everything', () => {
  assert.equal(exitQty(10, 1000, 250, 0.01), 2.5);
  assert.equal(exitQty(10, 1000, 990, 0.01), 10);
  assert.equal(exitQty(10, 1000, 5000, 1), 10);
});
