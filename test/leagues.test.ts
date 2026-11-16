import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { leagueOf, resolveTrade } from '../src/resolver.ts';
import type { IntlActivity } from '../src/types.ts';

const trade = (event_slug: string, slug = event_slug) =>
  ({ event_slug, slug, title: 'A vs. B', outcome: 'A', type: 'TRADE', side: 'BUY' }) as unknown as IntlActivity;

test('league code comes from the start of the event slug', () => {
  assert.equal(leagueOf(trade('nba-lal-bos-2026-11-08')), 'nba');
  assert.equal(leagueOf(trade('lal-elc-bet-2026-11-08')), 'lal');
});

test('a league not in LEAGUES is skipped before any lookup', async () => {
  // Real case (2026-11-08): soccer totals copied live although the backtest only covered NBA.
  const r = await resolveTrade(trade('lal-elc-bet-2026-11-08', 'lal-elc-bet-2026-11-08-total-2pt5'), ['moneyline', 'spread'], ['nba']);
  assert.match(r.error ?? '', /league "lal" is not in LEAGUES/);
});

test('LEAGUES parses to lowercase codes; empty means every league', () => {
  const base = { TARGET_PROXY_WALLET: '0x2879ded7fe05df00eddbb2fba412a0d30964411a' };
  assert.deepEqual(loadConfig({ ...base, LEAGUES: ' NBA, nfl ' }).LEAGUES, ['nba', 'nfl']);
  assert.deepEqual(loadConfig(base).LEAGUES, []);
});
