import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig, type Config } from './config.ts';
import { DATA_DIR, HEARTBEAT_FILE, STATE_FILE } from './paths.ts';
import { Executor, getBbo, OrderUncertainError } from './executor.ts';
import { record, say, warn } from './log.ts';
import { notify, setupNotify } from './notify.ts';
import { checkEntry, checkExit } from './pricing.ts';
import { resolveTrade, withEventSlug } from './resolver.ts';
import { avgSlippage, haltReason, lossRoomCheck } from './limits.ts';
import { exitQty, scaledForBankroll, sizeOrder, tierOf, tierOrder } from './sizing.ts';
import type { GuardResult } from './pricing.ts';
import type { UsSide } from './types.ts';
import { StateStore } from './state.ts';
import type { IntlActivity } from './types.ts';
import { fetchNewTrades, tradeKey } from './watcher.ts';

const money = (n: number) => `$${n.toFixed(2)}`;
const cents = (p: number) => `${(p * 100).toFixed(1)}c`;
const labelOf = (t: IntlActivity) => `${t.outcome} · ${t.title}`;
const TIER_WORDS = ['½× bet', '1× bet', '2× bet'];
const describe = (t: IntlActivity) => `${t.side} "${t.outcome}" @ ${t.price} (${money(t.usdc_size)}) in "${t.title}"`;

/** Warn loudly the moment a stop rule trips (once), and say so if it clears after a limit was raised. */
let announcedHalt: string | undefined;
function checkHalt(cfg: Config, state: StateStore): string | undefined {
  const reason = haltReason(cfg, state.results, state.entry);
  if (reason && reason !== announcedHalt) {
    warn(`STOPPED OPENING NEW COPIES: ${reason}.`);
    warn('  Open copies are kept until their games finish, and whale sells are still copied. To resume, raise the limit in .env and restart.');
    record('halted', { reason, results: state.results, entry: state.entry });
    void notify('Bot stopped opening new bets', `${reason}. Open bets are kept until their games finish.`, { priority: 'high', tags: ['warning'] });
  } else if (!reason && announcedHalt) {
    say('Stop rule no longer applies; copying resumes.');
  }
  announcedHalt = reason;
  return reason;
}

async function handleBuy(whaleTrade: IntlActivity, cfg: Config, state: StateStore, exec: Executor): Promise<void> {
  const t = withEventSlug(whaleTrade);
  if (cfg.SIZING_MODE === 'whale_tier') return handleTierBuy(t, cfg, state, exec);
  if (t.usdc_size < cfg.MIN_WHALE_TRADE_USD) {
    say(`  skip: whale trade is only ${money(t.usdc_size)} (MIN_WHALE_TRADE_USD is ${money(cfg.MIN_WHALE_TRADE_USD)})`);
    record('skip_small', { whale: t });
    return;
  }
  const halted = checkHalt(cfg, state);
  if (halted) {
    say('  skip: stop rule is active (see the warning above)');
    record('skip_halted', { reason: halted, whale: t });
    return;
  }
  const res = await resolveTrade(t, cfg.MARKET_KINDS, cfg.LEAGUES);
  if (!res.resolved) {
    say(`  skip: ${res.error}`);
    record('skip', { reason: res.error, whale: t });
    return;
  }
  const { market, side, description } = res.resolved;
  const tick = market.orderPriceMinTickSize ?? 0.01;
  const minQty = market.minimumTradeQty ?? 1;
  say(`  matched US market ${market.slug} -> ${side} (${description})${res.how === 'search' ? ' [found by search]' : ''}`);

  // The whale sometimes buys both sides of one market. Copying the second side just locks in a loss
  // (we pay the spread twice), and on Polymarket US it would net against the first side anyway.
  const held = state.positions[market.slug];
  if (held && held.side !== side) {
    const reason = `whale is betting both sides; we already hold ${held.side} in this market`;
    say(`  skip: ${reason}`);
    record('skip_both_sides', { reason, usSlug: market.slug, side, whale: t });
    return;
  }

  const bbo = await getBbo(market.slug);
  const guard = checkEntry(bbo, side, t.price, cfg.MAX_SLIPPAGE_CENTS, tick);
  if (!guard.ok) {
    say(`  skip: ${guard.reason}`);
    record('skip_price', { reason: guard.reason, usSlug: market.slug, side, whalePrice: t.price, usPrice: guard.marketPrice, whale: t });
    return;
  }

  const sizing = scaledForBankroll(cfg, state.results.realizedPnlUsd);
  const size = sizeOrder(sizing, t.usdc_size, guard.limitPrice, minQty, state.openExposureUsd(), held?.costUsd ?? 0, state.gameExposureUsd(market.slug));
  if (!size.ok) {
    say(`  skip: ${size.reason}`);
    record('skip_size', { reason: size.reason, usSlug: market.slug, whale: t });
    return;
  }
  const room = lossRoomCheck(cfg, state.results, state.openExposureUsd(), size.usd);
  if (!room.ok) {
    say(`  skip: ${room.reason}`);
    record('skip_loss_limit', { reason: room.reason, usSlug: market.slug, whale: t });
    return;
  }

  say(`  ${cfg.DRY_RUN ? 'WOULD BUY' : 'BUYING'} ${size.qty} x ${side} @ limit ${guard.limitPrice} (US ask ${guard.marketPrice.toFixed(3)}, whale paid ${t.price}) = ~${money(size.usd)}`);
  const fill = await exec.place({ usSlug: market.slug, side, action: 'BUY', qty: size.qty, limitPrice: guard.limitPrice, tick });
  if (fill.note) say(`  ${fill.note}`);
  record(fill.simulated ? 'dry_buy' : 'buy', { usSlug: market.slug, side, qty: size.qty, limit: guard.limitPrice, fill, whale: t });
  if (fill.filledQty <= 0) return;

  state.addBuy({
    usSlug: market.slug,
    side,
    qty: fill.filledQty,
    costUsd: fill.filledQty * fill.avgPrice + (fill.feeUsd ?? 0),
    whaleTokenId: t.token_id,
    whaleShares: t.size,
    tick,
    minQty,
    label: labelOf(t),
  });
  state.recordFill(fill.avgPrice, t.price);
  const avg = avgSlippage(state.entry)!;
  if (!fill.simulated) {
    const cost = fill.filledQty * fill.avgPrice + (fill.feeUsd ?? 0);
    void notify(`Bet placed: ${money(cost)}`, `${labelOf(t)}\n${fill.filledQty} @ ${cents(fill.avgPrice)} (wallet paid ${cents(t.price)}, bet ${money(t.usdc_size)})\nBankroll ${money(sizing.USER_BANKROLL_USD)}`, { tags: ['moneybag'] });
  }
  say(`  ${fill.simulated ? 'simulated' : 'filled'} ${fill.filledQty} @ ${fill.avgPrice.toFixed(3)} (${((fill.avgPrice - t.price) * 100).toFixed(1)}c over the whale; average ${(avg * 100).toFixed(1)}c over ${state.entry.fills} fills). Open copies now ${money(state.openExposureUsd())} of ${money(sizing.USER_BANKROLL_USD)} bankroll`);
  checkHalt(cfg, state);
}

/**
 * whale_tier sizing (dry-run experiment): the bet size follows how much the whale has put on that
 * outcome so far, small trades included. One bet per game; if the whale's running total crosses into a
 * higher tier within TOP_UP_WINDOW_SEC of our first buy, we add to the same position.
 */
async function handleTierBuy(t: IntlActivity, cfg: Config, state: StateStore, exec: Executor): Promise<void> {
  const stake = state.addWhaleStake(t.token_id, t.usdc_size, t.timestamp);
  const sizing = scaledForBankroll(cfg, state.results.realizedPnlUsd);
  const held = state.findByWhaleToken(t.token_id);
  const skip = (event: string, reason: string, extra: Record<string, unknown> = {}) => {
    say(`  skip: ${reason}`);
    record(event, { reason, whaleStake: stake, whale: t, ...extra });
  };

  if (held) {
    const oldTier = held.tier ?? 0;
    const newTier = tierOf(stake, cfg.TIER_THRESHOLDS_USD);
    const ageSec = (Date.now() - Date.parse(held.openedAt)) / 1000;
    const event = t.usdc_size < cfg.MIN_WHALE_TRADE_USD ? 'skip_small' : 'skip_size';
    if (newTier <= oldTier) return skip(event, `already sized for this bet (whale total ${money(stake)}, tier ${oldTier})`, { usSlug: held.usSlug });
    if (ageSec > cfg.TOP_UP_WINDOW_SEC) {
      return skip(event, `whale total reached tier ${newTier}, but the ${Math.round(cfg.TOP_UP_WINDOW_SEC / 60)}-minute top-up window has closed`, { usSlug: held.usSlug });
    }
    if (checkHalt(cfg, state)) return skip('skip_halted', 'stop rule is active (see the warning above)');
    const bbo = await getBbo(held.usSlug);
    const guard = checkEntry(bbo, held.side, t.price, cfg.MAX_SLIPPAGE_CENTS, held.tick);
    if (!guard.ok) return skip('skip_price', `top-up: ${guard.reason}`, { usSlug: held.usSlug, side: held.side });
    const size = tierOrder(sizing, stake, held.costUsd, guard.limitPrice, held.minQty, state.openExposureUsd());
    if (!size.ok) return skip('skip_size', `top-up: ${size.reason}`, { usSlug: held.usSlug });
    say(`  whale's total on this bet is now ${money(stake)}: tier ${oldTier} -> ${size.tier}, topping up to ${money(size.targetUsd)}`);
    const m = { usSlug: held.usSlug, side: held.side, tick: held.tick, minQty: held.minQty };
    return executeBuy(cfg, state, exec, sizing.USER_BANKROLL_USD, t, m, guard, size, { tier: size.tier, whaleStake: stake, topUp: true });
  }

  if (t.usdc_size < cfg.MIN_WHALE_TRADE_USD) {
    say(`  skip: whale trade is only ${money(t.usdc_size)} (whale total on this bet ${money(stake)})`);
    record('skip_small', { whaleStake: stake, whale: t });
    return;
  }
  if (checkHalt(cfg, state)) return skip('skip_halted', 'stop rule is active (see the warning above)');
  const res = await resolveTrade(t, cfg.MARKET_KINDS, cfg.LEAGUES);
  if (!res.resolved) return skip('skip', res.error ?? 'could not match a Polymarket US market');
  const { market, side, description } = res.resolved;
  const tick = market.orderPriceMinTickSize ?? 0.01;
  const minQty = market.minimumTradeQty ?? 1;
  say(`  matched US market ${market.slug} -> ${side} (${description})${res.how === 'search' ? ' [found by search]' : ''}`);
  const other = state.positions[market.slug];
  if (other && other.side !== side) return skip('skip_both_sides', `whale is betting both sides; we already hold ${other.side} in this market`, { usSlug: market.slug });
  const onGame = state.gameExposureUsd(market.slug);
  if (onGame > 0) return skip('skip_size', `already $${onGame.toFixed(2)} on this game (one bet per game)`, { usSlug: market.slug });
  const bbo = await getBbo(market.slug);
  const guard = checkEntry(bbo, side, t.price, cfg.MAX_SLIPPAGE_CENTS, tick);
  if (!guard.ok) return skip('skip_price', guard.reason, { usSlug: market.slug, side, whalePrice: t.price, usPrice: guard.marketPrice });
  const size = tierOrder(sizing, stake, 0, guard.limitPrice, minQty, state.openExposureUsd());
  if (!size.ok) return skip('skip_size', size.reason, { usSlug: market.slug });
  say(`  whale's total on this bet so far ${money(stake)}: tier ${size.tier}, bet ${money(size.targetUsd)}`);
  const m = { usSlug: market.slug, side, tick, minQty };
  return executeBuy(cfg, state, exec, sizing.USER_BANKROLL_USD, t, m, guard, size, { tier: size.tier, whaleStake: stake, topUp: false });
}

/** Loss-room check, order, log, and bookkeeping for the tier path (new bets and top-ups). */
async function executeBuy(
  cfg: Config,
  state: StateStore,
  exec: Executor,
  bankroll: number,
  t: IntlActivity,
  m: { usSlug: string; side: UsSide; tick: number; minQty: number },
  guard: Extract<GuardResult, { ok: true }>,
  size: { qty: number; usd: number },
  extra: { tier: number; whaleStake: number; topUp: boolean },
): Promise<void> {
  const room = lossRoomCheck(cfg, state.results, state.openExposureUsd(), size.usd);
  if (!room.ok) {
    say(`  skip: ${room.reason}`);
    record('skip_loss_limit', { reason: room.reason, usSlug: m.usSlug, whale: t });
    return;
  }
  say(`  ${cfg.DRY_RUN ? 'WOULD BUY' : 'BUYING'} ${size.qty} x ${m.side} @ limit ${guard.limitPrice} (US ask ${guard.marketPrice.toFixed(3)}, whale paid ${t.price}) = ~${money(size.usd)}${extra.topUp ? ' [top-up]' : ''}`);
  const fill = await exec.place({ usSlug: m.usSlug, side: m.side, action: 'BUY', qty: size.qty, limitPrice: guard.limitPrice, tick: m.tick });
  if (fill.note) say(`  ${fill.note}`);
  record(fill.simulated ? 'dry_buy' : 'buy', { usSlug: m.usSlug, side: m.side, qty: size.qty, limit: guard.limitPrice, fill, ...extra, whale: t });
  if (fill.filledQty <= 0) return;
  state.addBuy({ usSlug: m.usSlug, side: m.side, qty: fill.filledQty, costUsd: fill.filledQty * fill.avgPrice + (fill.feeUsd ?? 0), whaleTokenId: t.token_id, whaleShares: t.size, tick: m.tick, minQty: m.minQty, label: labelOf(t) });
  if (!fill.simulated) {
    const cost = fill.filledQty * fill.avgPrice + (fill.feeUsd ?? 0);
    void notify(`${extra.topUp ? 'Top-up' : 'Bet placed'}: ${money(cost)}`, `${labelOf(t)}\n${fill.filledQty} @ ${cents(fill.avgPrice)} (wallet paid ${cents(t.price)}; wallet total on it ${money(extra.whaleStake)} = ${TIER_WORDS[extra.tier] ?? 'tier ' + extra.tier})\nBankroll ${money(bankroll)}`, { tags: ['moneybag'] });
  }
  state.setTier(m.usSlug, extra.tier);
  state.recordFill(fill.avgPrice, t.price);
  const avg = avgSlippage(state.entry)!;
  say(`  ${fill.simulated ? 'simulated' : 'filled'} ${fill.filledQty} @ ${fill.avgPrice.toFixed(3)} (${((fill.avgPrice - t.price) * 100).toFixed(1)}c over the whale; average ${(avg * 100).toFixed(1)}c over ${state.entry.fills} fills). Open copies now ${money(state.openExposureUsd())} of ${money(bankroll)} bankroll`);
  checkHalt(cfg, state);
}

async function handleSell(t: IntlActivity, cfg: Config, state: StateStore, exec: Executor): Promise<void> {
  if (!cfg.COPY_EXITS) return say('  skip: COPY_EXITS is off');
  const pos = state.findByWhaleToken(t.token_id);
  if (!pos) {
    say('  skip: we have no copied position for this outcome');
    record('skip_exit', { reason: 'no copied position', whale: t });
    return;
  }
  const bbo = await getBbo(pos.usSlug);
  const guard = checkExit(bbo, pos.side, pos.tick);
  if (!guard.ok) {
    warn(`  could not exit ${pos.usSlug}: ${guard.reason}. Position kept; check it on polymarket.us`);
    record('exit_blocked', { reason: guard.reason, position: pos, whale: t });
    return;
  }
  const qty = exitQty(pos.qty, pos.whaleShares, t.size, pos.minQty);
  if (qty <= 0) return say('  skip: whale sold too little to mirror at our size');

  say(`  ${cfg.DRY_RUN ? 'WOULD SELL' : 'SELLING'} ${qty} of ${pos.qty} x ${pos.side} ${pos.usSlug} @ limit ${guard.limitPrice} (US bid ${guard.marketPrice.toFixed(3)})`);
  const fill = await exec.place({ usSlug: pos.usSlug, side: pos.side, action: 'SELL', qty, limitPrice: guard.limitPrice, tick: pos.tick });
  if (fill.note) say(`  ${fill.note}`);
  record(fill.simulated ? 'dry_sell' : 'sell', { usSlug: pos.usSlug, side: pos.side, qty, limit: guard.limitPrice, fill, whale: t });
  if (fill.filledQty > 0) {
    const pnl = state.reduce(pos.usSlug, fill.filledQty, t.size, fill.filledQty * fill.avgPrice - (fill.feeUsd ?? 0));
    say(`  ${fill.simulated ? 'simulated sell' : 'sold'}: ${pnl >= 0 ? 'profit' : 'loss'} ${money(Math.abs(pnl))}. ${scoreboard(state)}`);
    if (!fill.simulated) void notify(`Sold (wallet sold): ${pnl >= 0 ? '+' : '-'}${money(Math.abs(pnl))}`, `${pos.label ?? pos.usSlug}\nSold ${fill.filledQty} @ ${cents(fill.avgPrice)}\n${scoreboard(state)}`, { tags: ['outbox_tray'] });
  }
}

function scoreboard(state: StateStore): string {
  const r = state.results;
  const pnl = r.realizedPnlUsd;
  return `Finished copies: ${r.settled} settled (${r.wins} won, ${r.losses} lost), total ${pnl >= 0 ? '+' : '-'}${money(Math.abs(pnl))}`;
}

/** Look at every open copy; when its game has settled, book the result and free up the bankroll. */
async function checkSettlements(cfg: Config, state: StateStore): Promise<void> {
  for (const slug of Object.keys(state.positions)) {
    let bbo;
    try {
      bbo = await getBbo(slug);
    } catch {
      continue; // try again next time
    }
    const px = bbo.settlementPx ? Number(bbo.settlementPx.value) : NaN;
    if (!Number.isFinite(px)) continue;
    const done = state.settle(slug, px);
    if (!done) continue;
    const { pnl, payout, position: p } = done;
    say(`Game over: ${slug} settled. Our ${p.side} copy (${p.qty} contracts, cost ${money(p.costUsd)}) paid ${money(payout)}: ${pnl >= 0 ? 'WON' : 'LOST'} ${money(Math.abs(pnl))}`);
    const bank = scaledForBankroll(cfg, state.results.realizedPnlUsd).USER_BANKROLL_USD;
    say(`  ${scoreboard(state)}. Open copies now ${money(state.openExposureUsd())}${cfg.COMPOUND_BANKROLL ? `. Bankroll now ${money(bank)}, next bet ${money(Math.min(cfg.MAX_ORDER_USD, bank * cfg.PCT_PER_TRADE))}` : ''}`);
    record('settled', { usSlug: slug, side: p.side, qty: p.qty, costUsd: p.costUsd, longSettle: px, payout, pnl, results: state.results });
    const r = state.results;
    void notify(`${pnl > 0 ? 'Won' : pnl < 0 ? 'Lost' : 'Push'} ${money(Math.abs(pnl))}`, `${p.label ?? slug}\nRecord ${r.wins}-${r.losses}, results ${r.realizedPnlUsd >= 0 ? '+' : '-'}${money(Math.abs(r.realizedPnlUsd))}, bankroll ${money(bank)}`, { tags: [pnl > 0 ? 'white_check_mark' : 'x'] });
    checkHalt(cfg, state);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  setupNotify(cfg);
  const state = new StateStore();
  const exec = new Executor(cfg);
  const startedAt = Math.floor(Date.now() / 1000);

  say('Polymarket copy bot starting');
  say(`  copying wallet ${cfg.TARGET_PROXY_WALLET}`);
  say(`  bankroll ${money(cfg.USER_BANKROLL_USD)}${cfg.ADDED_FUNDS_USD ? ` + ${money(cfg.ADDED_FUNDS_USD)} added later (not counted as profit)` : ''}, sizing ${cfg.SIZING_MODE}, orders ${money(cfg.MIN_ORDER_USD)}-${money(cfg.MAX_ORDER_USD)}, max slippage ${(cfg.MAX_SLIPPAGE_CENTS * 100).toFixed(1)}c`);
  say(`  max ${money(cfg.MAX_PER_MARKET_USD)} per market, ${money(cfg.MAX_PER_GAME_USD)} per game; ignore whale trades under ${money(cfg.MIN_WHALE_TRADE_USD)}`);
  say(`  leagues: ${cfg.LEAGUES.length ? cfg.LEAGUES.join(', ') : 'all'}; markets: ${cfg.MARKET_KINDS.join(', ')}; copy exits: ${cfg.COPY_EXITS ? 'yes' : 'no'}`);
  if (cfg.DRY_RUN) {
    say(`  DRY RUN: no real orders will be placed${exec.hasKeys ? ' (orders will be previewed with your API keys)' : ''}`);
  } else {
    warn('LIVE MODE: real orders with real money. Press Ctrl+C now to stop.');
    const bp = await exec.buyingPower().catch((e) => {
      throw new Error(`could not log in to Polymarket US with your API keys: ${(e as Error).message}`);
    });
    say(`  Polymarket US buying power: ${bp === undefined ? 'unknown' : money(bp)}`);
    // Money already in open copies is not buying power, so count it back in before comparing.
    const open = state.openExposureUsd();
    const needed = scaledForBankroll(cfg, state.results.realizedPnlUsd).USER_BANKROLL_USD; // bankroll after wins and losses
    if (bp !== undefined && bp + open < needed - 0.5) warn(`buying power ${money(bp)} + open copies ${money(open)} is below the bankroll ${money(needed)}; orders may be rejected`);
  }
  say(`  data folder: ${DATA_DIR}`);
  if (cfg.SIZING_MODE === 'whale_tier') {
    const base = scaledForBankroll(cfg, state.results.realizedPnlUsd).USER_BANKROLL_USD * cfg.PCT_PER_TRADE;
    const th = cfg.TIER_THRESHOLDS_USD;
    const bands = cfg.TIER_MULTIPLIERS.map((m, i) => `${i === 0 ? `under ${money(th[0]!)}` : i === th.length ? `over ${money(th[i - 1]!)}` : `${money(th[i - 1]!)}-${money(th[i]!)}`}: ${money(Math.min(cfg.MAX_ORDER_USD, base * m))}`);
    say(`  TIER SIZING by the whale's total on each bet: ${bands.join(', ')}; top-ups for ${Math.round(cfg.TOP_UP_WINDOW_SEC / 60)} min after our first buy; one bet per game`);
  }
  if (cfg.COMPOUND_BANKROLL) {
    const now = scaledForBankroll(cfg, state.results.realizedPnlUsd);
    say(`  bets grow and shrink with the bankroll: now ${money(now.USER_BANKROLL_USD)} (started ${money(cfg.USER_BANKROLL_USD)}${cfg.ADDED_FUNDS_USD ? `, ${money(cfg.ADDED_FUNDS_USD)} added` : ''}), so ${(cfg.PCT_PER_TRADE * 100).toFixed(0)}% per bet = ${money(Math.min(cfg.MAX_ORDER_USD, now.USER_BANKROLL_USD * cfg.PCT_PER_TRADE))}`);
  }
  const open = Object.keys(state.positions).length;
  if (open) say(`  ${open} copied position(s) remembered from before (${money(state.openExposureUsd())})`);
  if (state.results.settled) say(`  ${scoreboard(state)}`);
  const lossRule = cfg.MAX_LOSS_USD > 0 ? `stop at ${money(cfg.MAX_LOSS_USD)} lost (open bets count as lost)` : 'no loss limit';
  const slipRule = cfg.MAX_AVG_SLIPPAGE_CENTS > 0 ? `stop if we pay over ${(cfg.MAX_AVG_SLIPPAGE_CENTS * 100).toFixed(1)}c more than the whale on average (after ${cfg.SLIPPAGE_MIN_FILLS} fills)` : 'no copy-cost limit';
  say(`  stop rules: ${lossRule}; ${slipRule}`);
  const avg = avgSlippage(state.entry);
  if (avg !== undefined) say(`  copy cost so far: ${(avg * 100).toFixed(1)}c over the whale on average (${state.entry.fills} fills)`);
  checkHalt(cfg, state);
  say(`Watching for new trades every ${cfg.POLL_MS / 1000}s... (Ctrl+C to stop)`);
  if (cfg.NTFY_TOPIC && !cfg.DRY_RUN) say('  phone notifications: on (ntfy)');
  {
    const bank = scaledForBankroll(cfg, state.results.realizedPnlUsd).USER_BANKROLL_USD;
    void notify('Live bot started', `Copying ${cfg.TARGET_PROXY_WALLET.slice(0, 6)}...${cfg.TARGET_PROXY_WALLET.slice(-4)}. Bankroll ${money(bank)}. ${scoreboard(state)}.`, { priority: 'low', tags: ['arrow_forward'] });
  }

  const failures = new Map<string, number>();
  let stopping = false;
  let lastPollError = '';
  let pollFailingSince = 0;
  let pollAlerted = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    say('Stopping after the current step... (Ctrl+C again to force)');
  });

  let lastSettleCheck = 0;
  let lastBeat = 0;
  while (!stopping) {
    if (Date.now() - lastBeat >= 15_000) {
      // Lets the dashboard show whether the bot is running. Harmless if it fails.
      lastBeat = Date.now();
      try {
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(HEARTBEAT_FILE, JSON.stringify({ at: new Date().toISOString(), dryRun: cfg.DRY_RUN, wallet: cfg.TARGET_PROXY_WALLET, pid: process.pid }));
      } catch { /* ignore */ }
    }
    if (Date.now() - lastSettleCheck >= cfg.SETTLE_CHECK_MS) {
      lastSettleCheck = Date.now();
      await checkSettlements(cfg, state).catch((e) => warn(`could not check finished games: ${(e as Error).message}`));
    }
    try {
      const trades = await fetchNewTrades(cfg.TARGET_PROXY_WALLET, startedAt, (k) => state.hasSeen(k));
      lastPollError = '';
      if (pollAlerted) void notify('Bot can see the wallet again', 'Reading trades works again.', { tags: ['white_check_mark'] });
      pollFailingSince = 0;
      pollAlerted = false;
      for (const t of trades) {
        if (stopping) break;
        const key = tradeKey(t);
        const ageSec = Math.floor(Date.now() / 1000) - t.timestamp;
        say(`Whale ${describe(t)}`);
        try {
          if (ageSec > cfg.MAX_TRADE_AGE_SEC) {
            say(`  skip: trade is ${ageSec}s old (max ${cfg.MAX_TRADE_AGE_SEC}s)`);
            record('skip_stale', { ageSec, whale: t });
          } else if (t.side === 'BUY') {
            await handleBuy(t, cfg, state, exec);
          } else {
            await handleSell(t, cfg, state, exec);
          }
          state.markSeen(key);
        } catch (e) {
          if (e instanceof OrderUncertainError) {
            // Never retry: the order may already be on the exchange, and a retry could buy twice.
            warn(`  ${e.message}. NOT retrying. Check polymarket.us; if it filled, stop the bot and run: npx tsx tools/reconcile.ts --apply`);
            record('order_uncertain', { message: e.message, whale: t });
            void notify('CHECK POLYMARKET: order may have gone through', `${e.message}\nThe bot did NOT retry. Check your positions on polymarket.us.`, { priority: 'urgent', tags: ['rotating_light'] });
            state.markSeen(key);
            continue;
          }
          // Network hiccup or exchange error: try this trade again next poll, up to 3 times.
          const n = (failures.get(key) ?? 0) + 1;
          failures.set(key, n);
          warn(`  error (attempt ${n}/3): ${(e as Error).message}`);
          record('error', { attempt: n, message: (e as Error).message, whale: t });
          if (n >= 3) {
            state.markSeen(key);
            void notify('Bot skipped a bet after 3 errors', `${describe(t)}\n${(e as Error).message}`, { priority: 'high', tags: ['warning'] });
          }
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== lastPollError) warn(`could not read whale activity: ${msg} (will keep retrying)`);
      lastPollError = msg;
      pollFailingSince ||= Date.now();
      if (!pollAlerted && Date.now() - pollFailingSince > 5 * 60_000) {
        pollAlerted = true;
        void notify('Bot cannot see the wallet', `Reading the wallet's trades has failed for 5+ minutes: ${msg}. It keeps retrying.`, { priority: 'high', tags: ['warning'] });
      }
    }
    if (!stopping) await new Promise((r) => setTimeout(r, cfg.POLL_MS));
  }
  state.save();
  await notify('Live bot stopped', 'Stopped with Ctrl+C. Double-click start-live-bot.bat to start it again.', { tags: ['stop_sign'] });
  say(`Stopped. State saved to ${STATE_FILE}`);
}

main().catch(async (e) => {
  console.error(`\n${(e as Error).message}\n`);
  await notify('Live bot CRASHED', `${(e as Error).message}\nIt is not running. Double-click start-live-bot.bat to restart it.`, { priority: 'urgent', tags: ['rotating_light'] });
  process.exit(1);
});
