import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classifyIntlTrade, resolveInEvent, teamScore, type Resolved } from '../src/resolver.ts';
import type { UsEvent } from '../src/types.ts';

// Real US events saved from gateway.polymarket.us on 2026-11-03.
const load = (slug: string, reopen = true): UsEvent => {
  const ev = JSON.parse(readFileSync(new URL(`./fixtures/us-event-${slug}.json`, import.meta.url), 'utf8')) as UsEvent;
  if (reopen) for (const m of ev.markets ?? []) m.closed = false; // games are over now; test the mapping itself
  return ev;
};
const cfb = load('cfb-ohio-akron-2026-11-03');
const nba = load('nba-mia-lac-2026-11-04');
const nhl = load('nhl-car-nas-2026-11-03');
const ucl = load('ucl-bvb-rbb-2026-11-04');

// Intl trades in the exact formats seen on data-api.polymarket.com.
const intl = (event_slug: string, suffix: string, title: string, outcome: string) => ({ event_slug, slug: event_slug + suffix, title, outcome });

const ok = (r: Resolved | { error: string }): Resolved => {
  if ('error' in r) assert.fail(r.error);
  return r;
};

test('moneyline: first team -> LONG, second team -> SHORT', () => {
  const ohio = ok(resolveInEvent(classifyIntlTrade(intl('cfb-ohio-akron-2026-11-03', '', 'Ohio vs. Akron', 'Ohio')), cfb));
  assert.equal(ohio.market.slug, 'aec-cfb-ohio-akron-2026-11-03');
  assert.equal(ohio.side, 'LONG');
  const akron = ok(resolveInEvent(classifyIntlTrade(intl('cfb-ohio-akron-2026-11-03', '', 'Ohio vs. Akron', 'Akron Zips')), cfb));
  assert.equal(akron.side, 'SHORT');
});

test('moneyline: short intl nickname matches full US team name', () => {
  const r = ok(resolveInEvent(classifyIntlTrade(intl('nba-mia-lac-2026-11-04', '', 'Heat vs. Clippers', 'Clippers')), nba));
  assert.equal(r.market.slug, 'aec-nba-mia-lac-2026-11-04');
  assert.equal(r.side, 'SHORT'); // US: long = Miami Heat, short = Los Angeles Clippers
});

test('spread: "Spread: Heat (-2.5)" outcome Clippers -> SHORT of Heat -2.5', () => {
  const bet = classifyIntlTrade(intl('nba-mia-lac-2026-11-04', '-spread-away-2pt5', 'Spread: Heat (-2.5)', 'Clippers'));
  assert.deepEqual(bet, { kind: 'spread', team: 'Clippers', handicap: 2.5 });
  const r = ok(resolveInEvent(bet, nba));
  assert.equal(r.market.slug, 'asc-nba-mia-lac-2026-11-04-neg-2pt5');
  assert.equal(r.side, 'SHORT');
});

test('spread: betting the favourite -> LONG of the matching line', () => {
  const r = ok(resolveInEvent(classifyIntlTrade(intl('nba-mia-lac-2026-11-04', '-spread-away-2pt5', 'Spread: Heat (-2.5)', 'Heat')), nba));
  assert.equal(r.market.slug, 'asc-nba-mia-lac-2026-11-04-neg-2pt5');
  assert.equal(r.side, 'LONG');
});

test('spread: home favourite (Predators -1.5), whale takes Hurricanes +1.5', () => {
  const r = ok(resolveInEvent(classifyIntlTrade(intl('nhl-car-nsh-2026-11-03', '-spread-home-1pt5', 'Spread: Predators (-1.5)', 'Hurricanes')), nhl));
  // US long = Hurricanes; "Hurricanes +1.5" is the long side of the pos-1pt5 market.
  assert.equal(r.market.slug, 'asc-nhl-car-nas-2026-11-03-pos-1pt5');
  assert.equal(r.side, 'LONG');
});

test('total: Under 4.5 -> SHORT of the game total, not a team total', () => {
  const r = ok(resolveInEvent(classifyIntlTrade(intl('nhl-car-nsh-2026-11-03', '-total-4pt5', 'Hurricanes vs. Predators: O/U 4.5', 'Under')), nhl));
  assert.equal(r.market.slug, 'tsc-nhl-car-nas-2026-11-03-4pt5');
  assert.equal(r.side, 'SHORT');
  const over = ok(resolveInEvent(classifyIntlTrade(intl('cfb-ohio-akron-2026-11-03', '-total-21pt5', 'Ohio vs. Akron: O/U 21.5', 'Over')), cfb));
  assert.equal(over.market.slug, 'tsc-cfb-ohio-akron-2026-11-03-total-21pt5');
  assert.equal(over.side, 'LONG');
});

test('soccer: "Will Dortmund win?" Yes -> LONG, No -> SHORT, draw market', () => {
  const yes = ok(resolveInEvent(classifyIntlTrade(intl('ucl-bvb-bet-2026-11-04', '-bvb', 'Will BV Borussia 09 Dortmund win on 2026-11-04?', 'Yes')), ucl));
  assert.equal(yes.market.slug, 'atc-ucl-bvb-rbb-2026-11-04-bvb');
  assert.equal(yes.side, 'LONG');
  const no = ok(resolveInEvent(classifyIntlTrade(intl('ucl-bvb-bet-2026-11-04', '-bet', 'Will Real Betis Seville win on 2026-11-04?', 'No')), ucl));
  assert.equal(no.market.slug, 'atc-ucl-bvb-rbb-2026-11-04-rbb');
  assert.equal(no.side, 'SHORT');
  const draw = ok(resolveInEvent(classifyIntlTrade(intl('ucl-bvb-bet-2026-11-04', '-draw', 'Will BV Borussia 09 Dortmund vs. Real Betis Seville end in a draw?', 'Yes')), ucl));
  assert.equal(draw.market.slug, 'atc-ucl-bvb-rbb-2026-11-04-draw');
});

test('unsupported markets are skipped with a reason', () => {
  for (const t of [
    intl('ucl-slp-ars-2026-11-04', '-exact-score-1-4', 'Exact Score: SK Slavia Praha 1 - 4 Arsenal FC?', 'Yes'),
    intl('cs2-hero-fal2-2026-11-03', '-map-handicap-home-1pt5', 'Map Handicap: FAL (-1.5) vs Heroic (+1.5)', 'Team Falcons'),
    { event_slug: '', slug: 'will-bitcoin-dip-to-66k-november-2-8-2026', title: 'Will Bitcoin dip to $66k?', outcome: 'Yes' },
  ]) {
    assert.equal(classifyIntlTrade(t).kind, 'unsupported', t.slug);
  }
});

test('closed (finished) markets are never matched', () => {
  const closed = load('cfb-ohio-akron-2026-11-03', false);
  const r = resolveInEvent(classifyIntlTrade(intl('cfb-ohio-akron-2026-11-03', '', 'Ohio vs. Akron', 'Ohio')), closed);
  assert.ok('error' in r);
});

test('team matching', () => {
  assert.ok(teamScore('Clippers', ['Los Angeles Clippers']) > 0);
  assert.ok(teamScore('Zips', ['Akron', 'Zips']) > 0);
  assert.equal(teamScore('Heat', ['Los Angeles Clippers', 'LAC']), 0);
});

test('Michigan State is not matched to Michigan (US names: "Mich. State" / "Michigan")', () => {
  const st = ['Spartans', 'Mich. State', 'Spartans', 'Mich. State', 'mst'];
  const um = ['Wolverines', 'Michigan', 'Wolverines', 'Michigan', 'mich'];
  assert.ok(teamScore('Michigan State', st) > teamScore('Michigan State', um));
  assert.ok(teamScore('Michigan', um) > teamScore('Michigan', st));
  assert.ok(teamScore('Heat', ['Miami Heat']) > 0);
  assert.equal(teamScore('Celtics', ['Miami Heat']), 0);
});
