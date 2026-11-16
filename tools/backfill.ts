/**
 * Backfill a DRY-RUN bot for a stretch when it was not running.
 *
 * Replays the whale's trades between --from and --to through the same rules the bot uses
 * (league/market filters, minimum whale size, sizing or tier sizing, one bet per game, loss limit),
 * and books each result once Polymarket US shows the market settled. Bets still open stay open,
 * and the running bot settles them later.
 *
 * Prices are an estimate: the US price at that moment is unknown afterwards, so each buy is assumed
 * to fill at the whale's price + 1 tick, like a dry run would when the US price matches the whale's.
 * Every record it writes is marked `backfilled: true`.
 *
 * Refuses to run against a live (DRY_RUN=false) config. Stop that dry-run bot first, then:
 *   npx cross-env DATA_DIR=... <same settings as its npm script> tsx tools/backfill.ts --from <ISO> --to <ISO> [--apply]
 * Without --apply it only prints what it would add.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { getJson } from '../src/http.ts';
import { getBbo, Executor } from '../src/executor.ts';
import { checkEntry } from '../src/pricing.ts';
import { resolveTrade, withEventSlug } from '../src/resolver.ts';
import { haltReason, lossRoomCheck } from '../src/limits.ts';
import { scaledForBankroll, sizeOrder, tierOf, tierOrder } from '../src/sizing.ts';
import { StateStore } from '../src/state.ts';
import { LOG_FILE, STATE_FILE } from '../src/paths.ts';
import { tradeKey } from '../src/watcher.ts';
import type { IntlActivity, IntlActivityPage, UsBbo, UsSide } from '../src/types.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const from = Date.parse(arg('--from') ?? '') / 1000;
const to = Date.parse(arg('--to') ?? '') / 1000;
const apply = process.argv.includes('--apply');
if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('usage: --from <ISO time> --to <ISO time> [--apply]');

const cfg = { ...loadConfig(), ADDED_FUNDS_USD: 0 }; // added funds belong to the live account only
if (!cfg.DRY_RUN) throw new Error('refusing: backfill is only for dry-run bots (DRY_RUN=true)');
const exec = new Executor({ ...cfg, POLYMARKET_KEY_ID: '', POLYMARKET_SECRET_KEY: '' } as typeof cfg);

// Work on a copy of the state in memory; nothing is written unless --apply.
const state = new StateStore(STATE_FILE);
(state as unknown as { save: () => void }).save = () => {};
const out: Record<string, unknown>[] = [];
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const rec = (atSec: number, event: string, d: Record<string, unknown>) => out.push({ at: iso(atSec), event, backfilled: true, ...d });
const money = (n: number) => `$${n.toFixed(2)}`;

// 1. The whale's trades in the window, oldest first.
async function tradesInWindow(): Promise<IntlActivity[]> {
  const res: IntlActivity[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 40; page++) {
    const url = `https://data-api.polymarket.com/v2/activity?user=${cfg.TARGET_PROXY_WALLET}&type=TRADE&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const p = await getJson<IntlActivityPage>(url);
    let old = false;
    for (const t of p.data ?? []) {
      if (t.timestamp < from) { old = true; continue; }
      if (t.timestamp <= to && t.type === 'TRADE') res.push(t);
    }
    cursor = p.pagination?.next_cursor ?? undefined;
    if (old || !cursor || !p.pagination?.has_more) break;
  }
  return res.sort((a, b) => a.timestamp - b.timestamp);
}

// 2. Settlement from Polymarket US. The time of the market's last trade stands in for when the game ended,
//    so results are booked in the right order (and free up bankroll for later bets, as the bot would).
const settledInfo = new Map<string, { px: number; at: number } | null>();
async function settlement(slug: string): Promise<{ px: number; at: number } | null> {
  if (settledInfo.has(slug)) return settledInfo.get(slug)!;
  const bbo = (await getBbo(slug).catch(() => undefined)) as (UsBbo & { lastPriceSample?: { ts?: string } }) | undefined;
  const px = bbo?.settlementPx ? Number(bbo.settlementPx.value) : NaN;
  const at = bbo?.lastPriceSample?.ts ? Date.parse(bbo.lastPriceSample.ts) / 1000 : NaN;
  const v = Number.isFinite(px) && Number.isFinite(at) ? { px, at } : null;
  settledInfo.set(slug, v);
  return v;
}
const backfilled = new Set<string>(); // usSlugs opened by this backfill

async function settleUpTo(nowSec: number) {
  for (const slug of Object.keys(state.positions)) {
    if (!backfilled.has(slug)) continue; // a position from before the gap; the bot handles it
    const s = await settlement(slug);
    if (!s || s.at > nowSec) continue;
    const done = state.settle(slug, s.px)!;
    rec(s.at, 'settled', { usSlug: slug, side: done.position.side, qty: done.position.qty, costUsd: done.position.costUsd, longSettle: s.px, payout: done.payout, pnl: done.pnl, results: { ...state.results } });
    console.log(`  ${iso(s.at).slice(0, 16)} settled ${slug}: ${done.pnl >= 0 ? 'WON' : 'LOST'} ${money(Math.abs(done.pnl))}`);
  }
}

// A book where our side can be bought at exactly the whale's price.
const fakeBbo = (side: UsSide, price: number): UsBbo => (side === 'LONG'
  ? { state: 'MARKET_STATE_OPEN', bestAsk: { value: String(price) }, bestBid: { value: String(Math.max(0.001, price - 0.02)) } }
  : { state: 'MARKET_STATE_OPEN', bestBid: { value: String(1 - price) }, bestAsk: { value: String(Math.min(0.999, 1 - price + 0.02)) } }) as UsBbo;

async function buy(t: IntlActivity, m: { usSlug: string; side: UsSide; tick: number; minQty: number }, limit: number, size: { qty: number; usd: number }, extra: Record<string, unknown>) {
  const room = lossRoomCheck(cfg, state.results, state.openExposureUsd(), size.usd);
  if (!room.ok) return rec(t.timestamp, 'skip_loss_limit', { reason: room.reason, usSlug: m.usSlug, whale: t });
  const fill = await exec.place({ usSlug: m.usSlug, side: m.side, action: 'BUY', qty: size.qty, limitPrice: limit, tick: m.tick });
  fill.note = 'backfilled: bot was off; assumed fill at whale price + 1 tick';
  rec(t.timestamp, 'dry_buy', { usSlug: m.usSlug, side: m.side, qty: size.qty, limit, fill, ...extra, whale: t });
  state.addBuy({ usSlug: m.usSlug, side: m.side, qty: fill.filledQty, costUsd: fill.filledQty * fill.avgPrice, whaleTokenId: t.token_id, whaleShares: t.size, tick: m.tick, minQty: m.minQty });
  state.positions[m.usSlug]!.openedAt = iso(t.timestamp);
  if (typeof extra.tier === 'number') state.setTier(m.usSlug, extra.tier);
  state.recordFill(fill.avgPrice, t.price);
  backfilled.add(m.usSlug);
  console.log(`  ${iso(t.timestamp).slice(0, 16)} BUY ${fill.filledQty} x ${m.side} ${m.usSlug} @ ${limit} = ${money(fill.filledQty * fill.avgPrice)} (whale ${money(t.usdc_size)} on ${t.outcome})${extra.topUp ? ' [top-up]' : ''}`);
}

async function handle(raw: IntlActivity) {
  const t = withEventSlug(raw);
  const skip = (event: string, reason: string) => rec(t.timestamp, event, { reason, whale: t });
  if (t.side !== 'BUY') {
    // A whale sell of something we would hold: we can't know the US bid then, so just report it.
    if (state.findByWhaleToken(t.token_id)) console.log(`  NOTE: whale sold ${t.outcome} at ${t.price}; backfill keeps the position to settlement`);
    return;
  }
  const tier = cfg.SIZING_MODE === 'whale_tier';
  const stake = tier ? state.addWhaleStake(t.token_id, t.usdc_size, t.timestamp) : t.usdc_size;
  const held = state.findByWhaleToken(t.token_id);
  if (tier && held) {
    const oldTier = held.tier ?? 0, newTier = tierOf(stake, cfg.TIER_THRESHOLDS_USD);
    if (newTier <= oldTier) return skip(t.usdc_size < cfg.MIN_WHALE_TRADE_USD ? 'skip_small' : 'skip_size', `already sized for this bet (whale total ${money(stake)})`);
    if (t.timestamp - Date.parse(held.openedAt) / 1000 > cfg.TOP_UP_WINDOW_SEC) return skip('skip_size', 'top-up window has closed');
    const sizing = scaledForBankroll(cfg, state.results.realizedPnlUsd);
    const g = checkEntry(fakeBbo(held.side, t.price), held.side, t.price, cfg.MAX_SLIPPAGE_CENTS, held.tick);
    if (!g.ok) return skip('skip_price', g.reason);
    const size = tierOrder(sizing, stake, held.costUsd, g.limitPrice, held.minQty, state.openExposureUsd());
    if (!size.ok) return skip('skip_size', `top-up: ${size.reason}`);
    return buy(t, { usSlug: held.usSlug, side: held.side, tick: held.tick, minQty: held.minQty }, g.limitPrice, size, { tier: size.tier, whaleStake: stake, topUp: true });
  }
  if (t.usdc_size < cfg.MIN_WHALE_TRADE_USD) return skip('skip_small', `whale trade is only ${money(t.usdc_size)}`);
  const halted = haltReason(cfg, state.results, state.entry);
  if (halted) return skip('skip_halted', halted);
  let res = await resolveTrade(t, cfg.MARKET_KINDS, cfg.LEAGUES, true);
  if (!res.resolved && /no matching US event/.test(res.error ?? '')) {
    // US search skips finished games, so try known team-code differences directly (intl "wsh" = US "was").
    const alias = t.event_slug.replace(/-wsh-/, '-was-').replace(/-wsh-/, '-was-');
    if (alias !== t.event_slug) res = await resolveTrade({ ...t, event_slug: alias, slug: t.slug.replace(t.event_slug, alias) }, cfg.MARKET_KINDS, cfg.LEAGUES, true);
  }
  if (!res.resolved) { console.log(`  ${iso(t.timestamp).slice(0, 16)} skip ${t.slug}: ${res.error}`); return skip('skip', res.error ?? 'no US market'); }
  const { market, side } = res.resolved;
  const tick = market.orderPriceMinTickSize ?? 0.01, minQty = market.minimumTradeQty ?? 1;
  const other = state.positions[market.slug];
  if (other && other.side !== side) return skip('skip_both_sides', `whale is betting both sides; we already hold ${other.side}`);
  if (tier && state.gameExposureUsd(market.slug) > 0) return skip('skip_size', 'one bet per game');
  const g = checkEntry(fakeBbo(side, t.price), side, t.price, cfg.MAX_SLIPPAGE_CENTS, tick);
  if (!g.ok) return skip('skip_price', g.reason);
  const sizing = scaledForBankroll(cfg, state.results.realizedPnlUsd);
  const m = { usSlug: market.slug, side, tick, minQty };
  if (tier) {
    const size = tierOrder(sizing, stake, 0, g.limitPrice, minQty, state.openExposureUsd());
    if (!size.ok) return skip('skip_size', size.reason);
    return buy(t, m, g.limitPrice, size, { tier: size.tier, whaleStake: stake, topUp: false });
  }
  const size = sizeOrder(sizing, t.usdc_size, g.limitPrice, minQty, state.openExposureUsd(), other?.costUsd ?? 0, state.gameExposureUsd(market.slug));
  if (!size.ok) return skip('skip_size', size.reason);
  return buy(t, m, g.limitPrice, size, {});
}

const trades = await tradesInWindow();
const fresh = trades.filter((t) => !state.hasSeen(tradeKey(t)));
console.log(`${cfg.TARGET_PROXY_WALLET.slice(0, 8)} ${cfg.SIZING_MODE}: ${fresh.length} whale trades from ${iso(from)} to ${iso(to)} the bot never saw`);
for (const t of fresh) {
  await settleUpTo(t.timestamp);
  await handle(t);
  state.markSeen(tradeKey(t));
}
await settleUpTo(Date.now() / 1000);
const buys = out.filter((r) => r.event === 'dry_buy').length;
console.log(`=> ${buys} bets added, ${out.filter((r) => r.event === 'settled').length} settled, ${Object.keys(state.positions).filter((s) => backfilled.has(s)).length} still open. Results now ${JSON.stringify(state.results)}`);

if (!apply) {
  console.log('(preview only; run again with --apply to write it)');
} else {
  copyFileSync(STATE_FILE, `${STATE_FILE}.before-backfill`);
  copyFileSync(LOG_FILE, `${LOG_FILE}.before-backfill`);
  const real = StateStore.prototype.save;
  real.call(state);
  // Merge the new records into the log in time order so the dashboard reads them naturally.
  const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const all = [...lines, ...out].map((r, i) => ({ r, i })).sort((a, b) => (a.r.at < b.r.at ? -1 : a.r.at > b.r.at ? 1 : a.i - b.i));
  writeFileSync(LOG_FILE, all.map((x) => JSON.stringify(x.r)).join('\n') + '\n');
  console.log(`written (backups: ${STATE_FILE}.before-backfill, ${LOG_FILE}.before-backfill)`);
}
