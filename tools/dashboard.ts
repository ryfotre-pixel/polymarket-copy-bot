// Local dashboard for the copy bot. Read-only: it reads the bot's files and your account balance,
// and never places or changes orders. Only this computer can open it (it listens on 127.0.0.1).
//
//   npm run dashboard      then open http://localhost:4321
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { PolymarketUS } from 'polymarket-us';
import { loadConfig } from '../src/config.ts';
import { scaledForBankroll } from '../src/sizing.ts';
import { sendNtfy } from '../src/notify.ts';

const PORT = Number(process.env.DASHBOARD_PORT ?? 4321);
const cfg = loadConfig();

/** Data folders the page can switch between. `start` is the bankroll that run started with. */
const SOURCES: Record<string, { dir: string; label: string; start: number; added?: number; wallet?: string; name?: string; sized?: boolean; tiers?: number[] }> = {
  live: { dir: 'data', label: 'Live run', start: cfg.USER_BANKROLL_USD + cfg.ADDED_FUNDS_USD, added: cfg.ADDED_FUNDS_USD, name: cfg.TARGET_PROXY_WALLET.toLowerCase() === '0x2879ded7fe05df00eddbb2fba412a0d30964411a' ? 'chongchong37' : `${cfg.TARGET_PROXY_WALLET.slice(0, 6)}…${cfg.TARGET_PROXY_WALLET.slice(-4)}`, sized: cfg.SIZING_MODE === 'whale_tier' },
  sized: { dir: 'data-sized', label: 'chongchong37 sized (dry run)', start: cfg.USER_BANKROLL_USD, wallet: '0x2879ded7fe05df00eddbb2fba412a0d30964411a', name: 'chongchong37', sized: true, tiers: [3000, 8000] },
  w9674: { dir: 'data-w9674', label: 'Wallet 0x9674 (dry run)', start: 100, wallet: '0x9674de4a6cf9988c629cafac79c6803984e11302', name: '0x9674…1302' },
  w9674sized: { dir: 'data-w9674-sized', label: 'Wallet 0x9674 sized (dry run)', start: 100, wallet: '0x9674de4a6cf9988c629cafac79c6803984e11302', name: '0x9674…1302', sized: true, tiers: [300, 600] },
  dry3: { dir: 'data-run3-dry', label: 'Dry run 3 (archive)', start: 90 },
};

interface LogRow { at: string; event: string; [k: string]: any }

function readLog(dir: string): LogRow[] {
  const f = `${dir}/trades.log`;
  if (!existsSync(f)) return [];
  const out: LogRow[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* half-written line */ }
  }
  return out;
}

const mtime = (f: string) => (existsSync(f) ? statSync(f).mtime.toISOString() : undefined);

function build(srcKey: string) {
  const src = SOURCES[srcKey] ?? SOURCES.live!;
  const stateFile = `${src.dir}/state.json`;
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { positions: {}, results: { settled: 0, wins: 0, losses: 0, realizedPnlUsd: 0 }, entry: { fills: 0, slipSum: 0 } };
  const results = state.results ?? { settled: 0, wins: 0, losses: 0, realizedPnlUsd: 0 };
  let entry = state.entry ?? { fills: 0, slipSum: 0 };
  const log = readLog(src.dir);

  // Bets: every buy/dry_buy that filled, joined with its settlement.
  const settledBySlug = new Map<string, LogRow>();
  for (const r of log) if (r.event === 'settled') settledBySlug.set(r.usSlug, r);
  // One bet per position: top-ups (sized bot) are merged into the first buy of the same market.
  const fills = log.filter((r) => (r.event === 'buy' || r.event === 'dry_buy') && r.fill?.filledQty > 0);
  const byPos = new Map<string, LogRow[]>();
  const when = (x: LogRow): string => x.originalAt ?? x.at; // repaired buys keep their real time
  fills.sort((a, b) => when(a).localeCompare(when(b)));
  for (const r of fills) {
    // a new position starts after the previous one settled
    const key = `${r.usSlug}#${[...settledBySlug.values()].filter((s) => s.usSlug === r.usSlug && s.at < when(r)).length}`;
    if (!byPos.has(key)) byPos.set(key, []);
    byPos.get(key)!.push(r);
  }
  const bets = [...byPos.values()].map((rs) => {
    const r = rs[0]!, lastR = rs.at(-1)!;
    const s = settledBySlug.get(r.usSlug);
    const qty = rs.reduce((a, x) => a + x.fill.filledQty, 0);
    const notional = rs.reduce((a, x) => a + x.fill.filledQty * x.fill.avgPrice, 0);
    const cost = notional + rs.reduce((a, x) => a + (x.fill.feeUsd ?? 0), 0); // fees included
    const slips = rs.filter((x) => +x.whale?.price).map((x) => x.fill.avgPrice - +x.whale.price);
    return {
      at: when(r), usSlug: r.usSlug, side: r.side, qty: +qty.toFixed(4), price: notional / qty, cost: +cost.toFixed(2),
      whalePrice: +r.whale?.price, whaleUsd: lastR.whaleStake ?? r.whale?.usdc_size, team: r.whale?.outcome, title: r.whale?.title, game: r.whale?.event_slug,
      slip: slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : null, simulated: !!r.fill.simulated, backfilled: !!r.backfilled,
      tier: typeof lastR.tier === 'number' ? lastR.tier : null, topUps: rs.length - 1,
      status: s ? (s.pnl > 0 ? 'won' : s.pnl < 0 ? 'lost' : 'push') : 'open', pnl: s ? s.pnl : null, settledAt: s?.at ?? null,
    };
  });
  const tierStats = bets.some((b) => b.tier !== null)
    ? [0, 1, 2].map((k) => {
        const bs = bets.filter((b) => b.tier === k), done = bs.filter((b) => b.status !== 'open');
        return { tier: k, bets: bs.length, won: done.filter((b) => b.status === 'won').length, lost: done.filter((b) => b.status === 'lost').length, open: bs.length - done.length, staked: +done.reduce((a, b) => a + b.cost, 0).toFixed(2), pnl: +done.reduce((a, b) => a + (b.pnl ?? 0), 0).toFixed(2) };
      })
    : null;

  // Older runs saved no copy-cost totals; work them out from the bets instead.
  if (!entry.fills) {
    const withSlip = bets.filter((b) => b.slip !== null);
    entry = { fills: withSlip.length, slipSum: withSlip.reduce((a, b) => a + (b.slip as number), 0) };
  }

  // Bankroll over time: start, then one point per settled game.
  let bank = src.start;
  const equity = [{ at: log[0]?.at ?? new Date().toISOString(), bankroll: bank, label: 'start' }];
  for (const r of log) if (r.event === 'settled') { bank = +(bank + r.pnl).toFixed(2); equity.push({ at: r.at, bankroll: bank, label: r.usSlug }); }

  // Skip reasons, grouped.
  const skips: Record<string, number> = {};
  const group = (r: LogRow) => {
    if (r.event === 'skip_small') return 'Too small (under $' + cfg.MIN_WHALE_TRADE_USD + ')';
    if (r.event === 'skip_size') return /per game/.test(r.reason ?? '') ? 'Already bet this game' : 'Size limits';
    if (r.event === 'skip' && /not part of a game/.test(r.reason ?? '')) return 'Not a game market';
    if (r.event === 'skip' && /no matching US/.test(r.reason ?? '')) return 'Not listed on Polymarket US';
    if (r.event === 'skip_price') return 'Price moved too far';
    if (r.event === 'skip_both_sides') return 'Whale bet both sides';
    if (r.event === 'skip_halted' || r.event === 'skip_loss_limit') return 'Stop rule';
    if (r.event === 'skip_stale') return 'Seen too late';
    if (r.event.startsWith('skip')) return 'Other';
    return undefined;
  };
  for (const r of log) { const g = group(r); if (g) skips[g] = (skips[g] ?? 0) + 1; }

  // Feed: newest first, without the flood of tiny-trade skips.
  const feed = log
    .filter((r) => r.event !== 'skip_small')
    .slice(-200)
    .reverse()
    .map((r) => ({
      at: r.at, event: r.event, group: group(r) ?? null, reason: r.reason ?? null, usSlug: r.usSlug ?? null, side: r.side ?? null, pnl: r.pnl ?? null,
      team: r.whale?.outcome ?? null, title: r.whale?.title ?? null, whaleUsd: r.whale?.usdc_size ?? null, whalePrice: r.whale?.price ?? null,
      price: r.fill?.avgPrice ?? null, qty: r.fill?.filledQty ?? r.qty ?? null, message: r.message ?? null, backfilled: !!r.backfilled,
    }));

  const scaled = scaledForBankroll({ ...cfg, USER_BANKROLL_USD: src.start, ADDED_FUNDS_USD: 0 }, results.realizedPnlUsd); // `start` already includes any added funds
  const openExposure = Object.values<any>(state.positions ?? {}).reduce((a, p) => a + p.costUsd, 0);
  const heartbeat = existsSync(`${src.dir}/heartbeat.json`) ? JSON.parse(readFileSync(`${src.dir}/heartbeat.json`, 'utf8')) : null;
  const isLiveLog = log.some((r) => r.event === 'buy' || r.event === 'sell');
  return {
    source: srcKey, label: src.label, sources: Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.label])),
    mode: srcKey === 'live' ? (heartbeat ? (heartbeat.dryRun ? 'dry' : 'live') : cfg.DRY_RUN ? 'dry' : 'live') : isLiveLog ? 'live' : 'dry',
    wallet: src.wallet ?? cfg.TARGET_PROXY_WALLET,
    whaleName: src.name ?? 'chongchong37',
    lastActivity: [heartbeat?.at, mtime(stateFile), mtime(`${src.dir}/trades.log`)].filter(Boolean).sort().at(-1) ?? null,
    hasHeartbeat: !!heartbeat,
    startBankroll: src.start, addedFunds: src.added ?? 0, bankroll: scaled.USER_BANKROLL_USD, nextBet: Math.min(cfg.MAX_ORDER_USD, scaled.USER_BANKROLL_USD * cfg.PCT_PER_TRADE),
    results, entry, openExposure: +openExposure.toFixed(2),
    limits: { maxLoss: cfg.MAX_LOSS_USD, maxAvgSlip: cfg.MAX_AVG_SLIPPAGE_CENTS, minFills: cfg.SLIPPAGE_MIN_FILLS, perTradeSlip: cfg.MAX_SLIPPAGE_CENTS },
    halted: log.filter((r) => r.event === 'halted').at(-1)?.reason ?? null,
    positions: Object.values<any>(state.positions ?? {}),
    bets, equity, skips, feed, tierStats,
    tiers: { thresholds: src.tiers ?? cfg.TIER_THRESHOLDS_USD, multipliers: cfg.TIER_MULTIPLIERS, sized: !!src.sized },
    running: heartbeat ? Date.now() - Date.parse(heartbeat.at) < 60_000 : null,
    whaleTradesSeen: log.length,
    buyingPower: srcKey === 'live' ? balance : null,
  };
}

// Account balance, refreshed every minute (read-only API call).
let balance: { buyingPower: number; currentBalance: number; at: string } | null = null;
const client = cfg.POLYMARKET_KEY_ID && cfg.POLYMARKET_SECRET_KEY ? new PolymarketUS({ keyId: cfg.POLYMARKET_KEY_ID, secretKey: cfg.POLYMARKET_SECRET_KEY, timeout: 15_000 }) : undefined;
async function refreshBalance() {
  if (!client) return;
  try {
    const r: any = await client.account.balances();
    const b = r.balances?.find((x: any) => x.currency === 'USD') ?? r.balances?.[0];
    if (b) balance = { buyingPower: b.buyingPower, currentBalance: b.currentBalance, at: new Date().toISOString() };
  } catch { /* keep the last value */ }
}
await refreshBalance();
setInterval(refreshBalance, 60_000);

// Watchdog: phone alert if the LIVE bot stops checking in (crash, window closed), and again when it is back.
// Only runs when NTFY_TOPIC is set. Cannot help if the whole PC is off or restarting.
let liveDownAlerted = false;
async function watchLive() {
  if (!cfg.NTFY_TOPIC) return;
  try {
    if (!existsSync('data/heartbeat.json')) return;
    const hb = JSON.parse(readFileSync('data/heartbeat.json', 'utf8'));
    if (hb.dryRun) return;
    const ageMin = (Date.now() - Date.parse(hb.at)) / 60_000;
    if (ageMin > 3 && !liveDownAlerted) {
      liveDownAlerted = await sendNtfy(cfg.NTFY_SERVER, cfg.NTFY_TOPIC, 'Live bot is NOT running',
        `No check-in for ${Math.round(ageMin)} minutes (last ${new Date(hb.at).toLocaleString()}). Double-click start-live-bot.bat on the PC to restart it.`,
        { priority: 'urgent', tags: ['rotating_light'] });
    } else if (ageMin <= 1 && liveDownAlerted) {
      liveDownAlerted = false;
      await sendNtfy(cfg.NTFY_SERVER, cfg.NTFY_TOPIC, 'Live bot is running again', 'It is checking in normally.', { tags: ['white_check_mark'] });
    }
  } catch { /* try again next minute */ }
}
setInterval(watchLive, 60_000);

const page = new URL('./dashboard.html', import.meta.url);
createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api/compare') {
      // Flat (live) vs sized (dry run): bankroll lines and per-game results on the games both bet.
      // [flat source, sized source, flat label, sized label, wallet name]
      const PAIRS: Record<string, [string, string, string, string, string]> = {
        live: ['w9674', 'live', 'Flat bets (dry run)', 'Sized bets (live)', '0x9674…1302'],
        w9674: ['w9674', 'w9674sized', 'Flat bets (dry run)', 'Sized bets (dry run)', '0x9674…1302'],
      };
      const [flatKey, sizedKey, flatLabel, sizedLabel, whaleName] = PAIRS[url.searchParams.get('pair') ?? 'w9674'] ?? PAIRS.w9674!;
      const live = build(flatKey), sized = build(sizedKey);
      const liveByGame = new Map(live.bets.map((b) => [b.game, b]));
      const shared = sized.bets.filter((b) => liveByGame.has(b.game) && b.status !== 'open' && liveByGame.get(b.game)!.status !== 'open');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        series: [
          { key: 'live', label: flatLabel, start: live.startBankroll, equity: live.equity, bets: live.bets.length, pnl: live.results.realizedPnlUsd },
          { key: 'sized', label: sizedLabel, start: sized.startBankroll, equity: sized.equity, bets: sized.bets.length, pnl: sized.results.realizedPnlUsd },
        ],
        shared: { games: shared.length, flatPnl: +shared.reduce((a, b) => a + (liveByGame.get(b.game)!.pnl ?? 0), 0).toFixed(2), sizedPnl: +shared.reduce((a, b) => a + (b.pnl ?? 0), 0).toFixed(2) },
        tierStats: sized.tierStats,
        thresholds: sized.tiers.thresholds, whaleName, flatIsLive: flatKey === 'live', sizedIsLive: sizedKey === 'live',
      }));
    } else if (url.pathname === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(build(url.searchParams.get('src') ?? 'live')));
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(page));
    } else {
      res.writeHead(404).end('not found');
    }
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end((e as Error).message);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Dashboard: http://localhost:${PORT}  (read-only; Ctrl+C to stop)`));
