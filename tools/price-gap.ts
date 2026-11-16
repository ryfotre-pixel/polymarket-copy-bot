// Price-gap check: how often is Polymarket US cheaper than a sharper reference price?
// Reference: Polymarket International mid-price (much bigger, more liquid market). A sportsbook
// reference can be added later (see dkLines). Pre-game full-game moneylines only. Read-only: places no orders.
//
//   npx tsx tools/price-gap.ts            one snapshot, printed
//   npx tsx tools/price-gap.ts --loop 15  snapshot every 15 minutes, appended to data/price-gaps.jsonl
import { appendFileSync, mkdirSync } from 'node:fs';
import { getBbo } from '../src/executor.ts';
import { getJson } from '../src/http.ts';
import { sidePrices } from '../src/pricing.ts';
import { resolveTrade, teamScore } from '../src/resolver.ts';
import type { IntlActivity, UsSide } from '../src/types.ts';

const LEAGUES = ['nba', 'nfl', 'nhl', 'cfb', 'cbb'];
const GAME = /^(nba|nfl|nhl|cfb|cbb)-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/;
const HORIZON_H = 72;

interface GammaMarket { slug: string; outcomes?: string; bestBid?: number; bestAsk?: number; closed?: boolean; liquidityNum?: number }
interface GammaEvent { slug: string; title: string; markets?: GammaMarket[] }

export interface GapRow {
  at: string; league: string; event: string; usSlug: string; team: string; side: UsSide; start?: string;
  usAsk?: number; usBid?: number; intlMid?: number; intlSpread?: number; dkFair?: number;
  edgeVsIntl?: number; edgeVsDk?: number;
}

const amToProb = (s: string) => { const n = Number(s.replace('+', '')); return n > 0 ? 100 / (n + 100) : -n / (-n + 100); };

// Sportsbook reference: not wired up yet. ESPN's public pages refuse automated requests (HTTP 403),
// so a sportsbook feed needs a proper odds API with your own key (e.g. The Odds API). Until then
// this returns nothing and only the Polymarket International comparison runs.
// amToProb converts American odds (+150 / -200) to an implied probability for when a feed is added.
void amToProb;
async function dkLines(): Promise<{ date: string; home: string; away: string; homeAlt: string[]; awayAlt: string[]; pHome: number; pAway: number }[]> {
  return [];
}

export async function snapshot(): Promise<GapRow[]> {
  const at = new Date().toISOString();
  const dk = await dkLines();
  const rows: GapRow[] = [];
  for (const league of LEAGUES) {
    // Futures crowd the plain list, so ask only for events ending in the next few days, 100 per page.
    const min = new Date().toISOString().slice(0, 19) + 'Z';
    const max = new Date(Date.now() + (HORIZON_H + 24) * 3600e3).toISOString().slice(0, 19) + 'Z';
    const events: GammaEvent[] = [];
    for (let off = 0; off < 500; off += 100) {
      const page = await getJson<GammaEvent[]>(`https://gamma-api.polymarket.com/events?tag_slug=${league}&closed=false&limit=100&offset=${off}&end_date_min=${min}&end_date_max=${max}`).catch(() => []);
      events.push(...page);
      if (page.length < 100) break;
    }
    for (const ev of events) {
      if (!GAME.test(ev.slug)) continue;
      const m = ev.markets?.find((x) => x.slug === ev.slug && !x.closed);
      if (!m || m.bestBid === undefined || m.bestAsk === undefined) continue;
      const outcomes = JSON.parse(m.outcomes ?? '[]') as string[];
      if (outcomes.length !== 2) continue;
      // Ask the bot's own resolver which US market/side matches outcome 0.
      const fake = { slug: ev.slug, event_slug: ev.slug, title: ev.title, outcome: outcomes[0]!, price: 0.5, size: 1, usdc_size: 1 } as IntlActivity;
      const res = await resolveTrade(fake, ['moneyline']).catch(() => ({ resolved: undefined }));
      if (!res.resolved) continue;
      const { market, side } = res.resolved;
      const start = (market as any).gameStartTime as string | undefined;
      if (start && (Date.parse(start) < Date.now() || Date.parse(start) > Date.now() + HORIZON_H * 3600e3)) continue; // pre-game, next 3 days
      const bbo = await getBbo(market.slug).catch(() => undefined);
      if (!bbo || (bbo.state && bbo.state !== 'MARKET_STATE_OPEN')) continue;
      const other: UsSide = side === 'LONG' ? 'SHORT' : 'LONG';
      const intlMid0 = (m.bestBid + m.bestAsk) / 2;
      const game = dk.find((g: any) => Math.abs(Date.parse(g.date) - Date.parse(start ?? g.date)) < 6 * 3600e3 &&
        teamScore(outcomes[0]!, [g.home, ...g.homeAlt, g.away, ...g.awayAlt]) > 0 && teamScore(outcomes[1]!, [g.home, ...g.homeAlt, g.away, ...g.awayAlt]) > 0) as any;
      for (const [i, s] of [[0, side], [1, other]] as const) {
        const team = outcomes[i]!;
        const p = sidePrices(bbo, s);
        const intlMid = i === 0 ? intlMid0 : 1 - intlMid0;
        let dkFair: number | undefined;
        if (game) dkFair = teamScore(team, [game.home, ...game.homeAlt]) >= teamScore(team, [game.away, ...game.awayAlt]) ? game.pHome : game.pAway;
        rows.push({
          at, league, event: ev.slug, usSlug: market.slug, team, side: s, start,
          usAsk: p.buy, usBid: p.sell, intlMid, intlSpread: m.bestAsk - m.bestBid, dkFair,
          edgeVsIntl: p.buy !== undefined ? intlMid - p.buy : undefined,
          edgeVsDk: p.buy !== undefined && dkFair !== undefined ? dkFair - p.buy : undefined,
        });
      }
    }
  }
  return rows;
}

function summarize(rows: GapRow[]): void {
  const c = (xs: (number | undefined)[], th: number) => xs.filter((x) => x !== undefined && x >= th).length;
  const vi = rows.map((r) => r.edgeVsIntl), vd = rows.map((r) => r.edgeVsDk);
  const nd = vd.filter((x) => x !== undefined).length;
  console.log(`${rows.length / 2} games (${rows.length} sides) priced on Polymarket US, pre-game, next ${HORIZON_H}h`);
  console.log(`  vs Polymarket Intl mid: US cheaper by >=2c on ${c(vi, 0.02)} sides, >=3c on ${c(vi, 0.03)}, >=5c on ${c(vi, 0.05)}`);
  console.log(`  vs DraftKings no-vig (${nd} sides with DK odds): >=2c on ${c(vd, 0.02)}, >=3c on ${c(vd, 0.03)}, >=5c on ${c(vd, 0.05)}`);
  const top = [...rows].sort((a, b) => Math.max(b.edgeVsIntl ?? -1, b.edgeVsDk ?? -1) - Math.max(a.edgeVsIntl ?? -1, a.edgeVsDk ?? -1)).slice(0, 12);
  console.log('  biggest gaps (US ask vs references):');
  for (const r of top) {
    const f = (x?: number) => (x === undefined ? '  -  ' : x.toFixed(3));
    console.log(`   ${r.event.padEnd(28)} ${r.team.slice(0, 22).padEnd(22)} US ask ${f(r.usAsk)}  intl ${f(r.intlMid)} (spread ${f(r.intlSpread)})  DK ${f(r.dkFair)}  edge ${((r.edgeVsIntl ?? 0) * 100).toFixed(1)}c / ${r.edgeVsDk === undefined ? '-' : `${(r.edgeVsDk * 100).toFixed(1)}c`}`);
  }
}

const isMain = /price-gap\.ts$/.test(process.argv[1] ?? '');
const loopIdx = !isMain ? -2 : process.argv.indexOf('--loop');
if (loopIdx === -2) {
  // imported by another tool: do nothing
} else if (loopIdx < 0) {
  summarize(await snapshot());
} else {
  const mins = Number(process.argv[loopIdx + 1] ?? 15);
  mkdirSync('data', { recursive: true });
  for (;;) {
    try {
      const rows = await snapshot();
      for (const r of rows) appendFileSync('data/price-gaps.jsonl', `${JSON.stringify(r)}\n`);
      console.log(`[${new Date().toLocaleTimeString()}] logged ${rows.length} sides`);
      summarize(rows);
    } catch (e) {
      console.log(`[${new Date().toLocaleTimeString()}] snapshot failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, mins * 60e3));
  }
}
