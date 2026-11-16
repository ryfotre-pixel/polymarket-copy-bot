import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { scaledForBankroll, tierOf, tierOrder } from '../src/sizing.ts';
import { StateStore } from '../src/state.ts';

const W = `0x${'a'.repeat(40)}`;
const cfg = { USER_BANKROLL_USD: 100, PCT_PER_TRADE: 0.05, MIN_ORDER_USD: 1, MAX_ORDER_USD: 20, TIER_THRESHOLDS_USD: [3000, 8000], TIER_MULTIPLIERS: [0.5, 1, 2] };
const usd = (r: ReturnType<typeof tierOrder>) => (r.ok ? r.usd : NaN);

test('tiers: under $3k, $3k-$8k, over $8k', () => {
  assert.equal(tierOf(150, [3000, 8000]), 0);
  assert.equal(tierOf(3000, [3000, 8000]), 1);
  assert.equal(tierOf(7999, [3000, 8000]), 1);
  assert.equal(tierOf(44800, [3000, 8000]), 2);
});

test('bet size is $2.50 / $5 / $10 at a $100 bankroll', () => {
  assert.equal(usd(tierOrder(cfg, 500, 0, 0.5, 0.01, 0)), 2.5);
  assert.equal(usd(tierOrder(cfg, 5000, 0, 0.5, 0.01, 0)), 5);
  assert.equal(usd(tierOrder(cfg, 9000, 0, 0.5, 0.01, 0)), 10);
});

test('top-up buys only the difference to the new tier', () => {
  assert.equal(usd(tierOrder(cfg, 9000, 2.5, 0.5, 0.01, 2.5)), 7.5); // tier 0 -> 2
  assert.equal(usd(tierOrder(cfg, 5000, 2.5, 0.5, 0.01, 2.5)), 2.5); // tier 0 -> 1
  const same = tierOrder(cfg, 5000, 5, 0.5, 0.01, 5);
  assert.equal(same.ok, false); // already at tier 1 size
});

test('tier bets scale with the bankroll and stay under MAX_ORDER_USD', () => {
  const up = scaledForBankroll({ ...cfg, MAX_PER_MARKET_USD: 20, MAX_PER_GAME_USD: 20, COMPOUND_BANKROLL: true }, 40); // $140
  assert.equal(usd(tierOrder(up, 9000, 0, 0.5, 0.01, 0)), 14);
  assert.equal(usd(tierOrder({ ...cfg, MAX_ORDER_USD: 10, USER_BANKROLL_USD: 300 }, 9000, 0, 0.5, 0.01, 0)), 10);
});

test('whale running total adds up small trades and forgets old ones', () => {
  const s = new StateStore(join(mkdtempSync(join(tmpdir(), 'copybot-')), 'state.json'));
  assert.equal(s.addWhaleStake('tok', 40, 1000), 40);
  assert.equal(s.addWhaleStake('tok', 2960, 1100), 3000);
  s.addWhaleStake('other', 10, 1000 + 4 * 86400); // 4 days later: 'tok' is dropped
  assert.equal(s.addWhaleStake('tok', 5, 1000 + 4 * 86400), 5);
});

test('live trading is refused outside the data folder', () => {
  assert.throws(() => loadConfig({ TARGET_PROXY_WALLET: W, DRY_RUN: 'false', POLYMARKET_KEY_ID: 'k', POLYMARKET_SECRET_KEY: 's', DATA_DIR: 'data-sized' }), /live trading only runs from the data folder/);
  assert.equal(loadConfig({ TARGET_PROXY_WALLET: W, DRY_RUN: 'true', DATA_DIR: 'data-sized' }).DATA_DIR, 'data-sized');
});

test('tier settings are checked', () => {
  const c = loadConfig({ TARGET_PROXY_WALLET: W, SIZING_MODE: 'whale_tier' });
  assert.deepEqual(c.TIER_THRESHOLDS_USD, [3000, 8000]);
  assert.deepEqual(c.TIER_MULTIPLIERS, [0.5, 1, 2]);
  assert.throws(() => loadConfig({ TARGET_PROXY_WALLET: W, SIZING_MODE: 'whale_tier', TIER_MULTIPLIERS: '1,2' }), /needs 3 numbers/);
  assert.throws(() => loadConfig({ TARGET_PROXY_WALLET: W, SIZING_MODE: 'whale_tier', TIER_THRESHOLDS_USD: '8000,3000' }), /must go up/);
});
