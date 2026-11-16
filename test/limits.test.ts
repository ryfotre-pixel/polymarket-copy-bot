import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { avgSlippage, haltReason, lossRoomCheck } from '../src/limits.ts';
import { StateStore } from '../src/state.ts';

const cfg = { MAX_LOSS_USD: 40, MAX_AVG_SLIPPAGE_CENTS: 0.025, SLIPPAGE_MIN_FILLS: 10 };
const res = (realizedPnlUsd: number) => ({ settled: 0, wins: 0, losses: 0, realizedPnlUsd });
const noFills = { fills: 0, slipSum: 0 };

test('loss limit halts once finished copies are down MAX_LOSS_USD', () => {
  assert.equal(haltReason(cfg, res(-39.99), noFills), undefined);
  assert.match(haltReason(cfg, res(-40), noFills)!, /loss limit reached/);
  assert.equal(haltReason({ ...cfg, MAX_LOSS_USD: 0 }, res(-80), noFills), undefined); // 0 = off
});

test('new copy is refused if open bets plus this one could push losses past the limit', () => {
  assert.equal(lossRoomCheck(cfg, res(0), 31.5, 4.5).ok, true); // worst case 36
  assert.equal(lossRoomCheck(cfg, res(0), 36, 4.5).ok, false); // worst case 40.5
  assert.equal(lossRoomCheck(cfg, res(-30), 4.5, 4.5).ok, true); // 39
  assert.equal(lossRoomCheck(cfg, res(-30), 9, 4.5).ok, false); // 43.5
  assert.equal(lossRoomCheck(cfg, res(+10), 40, 4.5).ok, true); // profits give more room: 34.5
});

test('copy-cost rule waits for enough fills, then halts when the average is too high', () => {
  assert.equal(haltReason(cfg, res(0), { fills: 9, slipSum: 9 * 0.05 }), undefined); // too few fills to judge
  assert.equal(haltReason(cfg, res(0), { fills: 10, slipSum: 10 * 0.02 }), undefined);
  assert.match(haltReason(cfg, res(0), { fills: 10, slipSum: 10 * 0.03 })!, /copy cost too high/);
});

test('fills are remembered in the state file across restarts', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'copybot-')), 'state.json');
  const s = new StateStore(file);
  s.recordFill(0.51, 0.49);
  s.recordFill(0.56, 0.55);
  const again = new StateStore(file);
  assert.equal(again.entry.fills, 2);
  assert.ok(Math.abs(avgSlippage(again.entry)! - 0.015) < 1e-9);
});

test('defaults: $40 loss limit, 2.5c average copy cost after 10 fills', () => {
  const c = loadConfig({ TARGET_PROXY_WALLET: `0x${'a'.repeat(40)}` });
  assert.equal(c.MAX_LOSS_USD, 40);
  assert.equal(c.MAX_AVG_SLIPPAGE_CENTS, 0.025);
  assert.equal(c.SLIPPAGE_MIN_FILLS, 10);
});

test('bets grow and shrink with the bankroll, and so do the per-game caps', async () => {
  const { scaledForBankroll, sizeOrder } = await import('../src/sizing.ts');
  const base = { SIZING_MODE: 'fixed_pct' as const, USER_BANKROLL_USD: 100, PCT_PER_TRADE: 0.05, WHALE_BANKROLL_USD: 50000, MIN_ORDER_USD: 1, MAX_ORDER_USD: 10, MAX_PER_MARKET_USD: 10, MAX_PER_GAME_USD: 5, COMPOUND_BANKROLL: true };
  const usdOf = (c: typeof base) => { const r = sizeOrder(c, 500, 0.5, 0.01, 0, 0, 0); return r.ok ? r.usd : NaN; };
  const up = scaledForBankroll(base, 20); // won $20 -> $120
  assert.equal(up.USER_BANKROLL_USD, 120);
  assert.equal(up.MAX_PER_GAME_USD, 6);
  assert.equal(usdOf(up), 6);
  const down = scaledForBankroll(base, -30); // lost $30 -> $70
  assert.equal(usdOf(down), 3.5);
  const big = scaledForBankroll(base, 200); // $300 -> 5% is $15, capped by MAX_ORDER_USD
  assert.equal(usdOf(big), 10);
  const off = scaledForBankroll({ ...base, COMPOUND_BANKROLL: false }, 50);
  assert.equal(off.USER_BANKROLL_USD, 100);
});

test('added funds raise the bet size but are not profit', async () => {
  const { scaledForBankroll } = await import('../src/sizing.ts');
  const base = { USER_BANKROLL_USD: 100, MAX_PER_MARKET_USD: 10, MAX_PER_GAME_USD: 5, COMPOUND_BANKROLL: true };
  const s = scaledForBankroll({ ...base, ADDED_FUNDS_USD: 10 }, -10.65); // $100 start, $10 promo, -$10.65 results
  assert.ok(Math.abs(s.USER_BANKROLL_USD - 99.35) < 1e-9);
  assert.ok(Math.abs(scaledForBankroll(base, -10.65).USER_BANKROLL_USD - 89.35) < 1e-9);
  assert.equal(scaledForBankroll({ ...base, COMPOUND_BANKROLL: false, ADDED_FUNDS_USD: 50 }, -20).USER_BANKROLL_USD, 150);
});
