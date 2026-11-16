import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withEventSlug } from '../src/resolver.ts';
import { sizeOrder } from '../src/sizing.ts';
import { gameOf, StateStore } from '../src/state.ts';

const freshStore = () => new StateStore(join(mkdtempSync(join(tmpdir(), 'copybot-')), 'state.json'));
const pos = (side: 'LONG' | 'SHORT', qty: number, costUsd: number) => ({
  usSlug: 'tsc-nba-mia-lac-2026-11-04-233pt5', side, qty, costUsd, whaleTokenId: side, whaleShares: 100, tick: 0.01, minQty: 0.01,
});

test('opposite-side buy in the same market is refused instead of overwriting the position', () => {
  const s = freshStore();
  s.addBuy(pos('SHORT', 9, 4.5));
  assert.throws(() => s.addBuy(pos('LONG', 8.82, 4.5)));
  assert.equal(s.openExposureUsd(), 4.5);
  assert.equal(s.positions['tsc-nba-mia-lac-2026-11-04-233pt5']!.side, 'SHORT');
});

test('same-side buys add up', () => {
  const s = freshStore();
  s.addBuy(pos('LONG', 8.82, 4.5));
  s.addBuy(pos('LONG', 8.82, 4.5));
  assert.equal(s.positions['tsc-nba-mia-lac-2026-11-04-233pt5']!.qty, 17.64);
  assert.equal(s.openExposureUsd(), 9);
});

test('settling books wins and losses and frees the bankroll', () => {
  const s = freshStore();
  s.addBuy(pos('SHORT', 10, 4.4)); // Under at 0.44
  const r = s.settle('tsc-nba-mia-lac-2026-11-04-233pt5', 0); // Over lost -> SHORT pays 1
  assert.equal(r!.payout, 10);
  assert.equal(r!.pnl, 5.6);
  assert.equal(s.openExposureUsd(), 0);
  s.addBuy(pos('LONG', 10, 5));
  assert.equal(s.settle('tsc-nba-mia-lac-2026-11-04-233pt5', 0)!.pnl, -5);
  assert.deepEqual(s.results, { settled: 2, wins: 1, losses: 1, realizedPnlUsd: 0.6 });
});

test('sells record profit on the part sold', () => {
  const s = freshStore();
  s.addBuy(pos('LONG', 10, 5));
  assert.equal(s.reduce('tsc-nba-mia-lac-2026-11-04-233pt5', 5, 50, 3), 0.5);
  assert.equal(s.openExposureUsd(), 2.5);
});

test('per-market cap limits repeat copies of the same bet', () => {
  const cfg = { SIZING_MODE: 'fixed_pct' as const, USER_BANKROLL_USD: 90, PCT_PER_TRADE: 0.05, WHALE_BANKROLL_USD: 50000, MIN_ORDER_USD: 1, MAX_ORDER_USD: 10, MAX_PER_MARKET_USD: 10 };
  assert.equal(sizeOrder(cfg, 500, 0.5, 0.01, 4.5, 4.5).ok, true); // second copy fits ($9)
  const third = sizeOrder(cfg, 500, 0.5, 0.01, 9, 9); // only $1 room left
  assert.ok(third.ok && third.usd <= 1);
  assert.equal(sizeOrder(cfg, 500, 0.5, 0.01, 9.5, 9.5).ok, false);
});

test('per-game cap counts every market of the same game', () => {
  assert.equal(gameOf('tsc-nba-uta-no-2026-11-04-233pt5'), 'nba-uta-no-2026-11-04');
  assert.equal(gameOf('asc-nba-ind-mem-2026-11-04-pos-7pt5'), 'nba-ind-mem-2026-11-04');
  assert.equal(gameOf('aec-nba-uta-no-2026-11-04'), 'nba-uta-no-2026-11-04');
  const s = freshStore();
  s.addBuy({ ...pos('SHORT', 9, 4.5), usSlug: 'tsc-nba-uta-no-2026-11-04-233pt5' });
  s.addBuy({ ...pos('SHORT', 9, 4.5), usSlug: 'tsc-nba-uta-no-2026-11-04-235pt5' });
  s.addBuy({ ...pos('LONG', 9, 4.5), usSlug: 'aec-nba-mia-lac-2026-11-04' });
  assert.equal(s.gameExposureUsd('tsc-nba-uta-no-2026-11-04-237pt5'), 9);
  const cfg = { SIZING_MODE: 'fixed_pct' as const, USER_BANKROLL_USD: 90, PCT_PER_TRADE: 0.05, WHALE_BANKROLL_USD: 50000, MIN_ORDER_USD: 1, MAX_ORDER_USD: 10, MAX_PER_GAME_USD: 10 };
  const third = sizeOrder(cfg, 500, 0.5, 0.01, 13.5, 0, 9); // a third Jazz-Pelicans total: only $1 room
  assert.ok(third.ok && third.usd <= 1);
  assert.equal(sizeOrder(cfg, 500, 0.5, 0.01, 13.5, 0, 9.5).ok, false);
});

test('blank event_slug is rebuilt from the market slug', () => {
  assert.equal(withEventSlug({ slug: 'nba-mia-lac-2026-11-04-total-233pt5', event_slug: '' }).event_slug, 'nba-mia-lac-2026-11-04');
  assert.equal(withEventSlug({ slug: 'nba-lal-sac-2026-11-04-spread-away-11pt5', event_slug: '' }).event_slug, 'nba-lal-sac-2026-11-04');
  assert.equal(withEventSlug({ slug: 'kbo-sam-kt-2026-11-04', event_slug: '' }).event_slug, 'kbo-sam-kt-2026-11-04');
  assert.equal(withEventSlug({ slug: 'will-it-rain', event_slug: '' }).event_slug, '');
});

test('bets on a "-more-markets" page are treated as part of the game', async () => {
  const { withEventSlug, classifyIntlTrade } = await import('../src/resolver.ts');
  const t = withEventSlug({ slug: 'epl-sun-che-2026-11-08-total-2pt5', event_slug: 'epl-sun-che-2026-11-08-more-markets', title: 'Sunderland AFC vs. Chelsea FC: O/U 2.5', outcome: 'Under' });
  assert.equal(t.event_slug, 'epl-sun-che-2026-11-08');
  assert.deepEqual(classifyIntlTrade(t), { kind: 'total', line: 2.5, over: false });
  // first-half / team totals still aren't copied
  const h = withEventSlug({ slug: 'epl-sun-che-2026-11-08-first-half-total-1pt5', event_slug: 'epl-sun-che-2026-11-08-more-markets', title: 'x', outcome: 'Over' });
  assert.equal(classifyIntlTrade(h).kind, 'unsupported');
});
