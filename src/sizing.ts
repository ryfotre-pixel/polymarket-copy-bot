import type { Config } from './config.ts';

export type SizeResult = { ok: true; qty: number; usd: number } | { ok: false; reason: string };

/** Round down to a multiple of `step` without float noise (0.01 steps stay 0.01 steps). */
export function floorToStep(x: number, step: number): number {
  const decimals = Math.max(0, (step.toString().split('.')[1] ?? '').length);
  return Number((Math.floor(x / step + 1e-9) * step).toFixed(decimals));
}

/**
 * How many contracts to buy.
 *  - fixed_pct:   bankroll x PCT_PER_TRADE
 *  - whale_ratio: whale's dollars x (bankroll / WHALE_BANKROLL_USD)
 * Then clamp to [MIN_ORDER_USD, MAX_ORDER_USD], never exceed the bankroll still free
 * or the room left under MAX_PER_MARKET_USD in this market,
 * and round down to the market's minimumTradeQty.
 */
export function sizeOrder(
  cfg: Pick<Config, 'SIZING_MODE' | 'USER_BANKROLL_USD' | 'PCT_PER_TRADE' | 'WHALE_BANKROLL_USD' | 'MIN_ORDER_USD' | 'MAX_ORDER_USD'> &
    Partial<Pick<Config, 'MAX_PER_MARKET_USD' | 'MAX_PER_GAME_USD'>>,
  whaleUsd: number,
  price: number,
  minQty: number,
  openExposureUsd: number,
  marketExposureUsd = 0,
  gameExposureUsd = 0,
): SizeResult {
  if (!(price > 0 && price < 1)) return { ok: false, reason: `bad price ${price}` };
  const raw = cfg.SIZING_MODE === 'fixed_pct' ? cfg.USER_BANKROLL_USD * cfg.PCT_PER_TRADE : whaleUsd * (cfg.USER_BANKROLL_USD / cfg.WHALE_BANKROLL_USD);
  const free = cfg.USER_BANKROLL_USD - openExposureUsd;
  let usd = Math.min(Math.max(raw, cfg.MIN_ORDER_USD), cfg.MAX_ORDER_USD);
  if (free < cfg.MIN_ORDER_USD) return { ok: false, reason: `bankroll fully used ($${openExposureUsd.toFixed(2)} of $${cfg.USER_BANKROLL_USD} in open copies)` };
  usd = Math.min(usd, free);
  if (cfg.MAX_PER_MARKET_USD !== undefined) {
    const roomInMarket = cfg.MAX_PER_MARKET_USD - marketExposureUsd;
    if (roomInMarket < cfg.MIN_ORDER_USD) {
      return { ok: false, reason: `already $${marketExposureUsd.toFixed(2)} in this market (max $${cfg.MAX_PER_MARKET_USD} per market)` };
    }
    usd = Math.min(usd, roomInMarket);
  }
  if (cfg.MAX_PER_GAME_USD !== undefined) {
    const roomInGame = cfg.MAX_PER_GAME_USD - gameExposureUsd;
    if (roomInGame < cfg.MIN_ORDER_USD) {
      return { ok: false, reason: `already $${gameExposureUsd.toFixed(2)} on this game (max $${cfg.MAX_PER_GAME_USD} per game)` };
    }
    usd = Math.min(usd, roomInGame);
  }
  const step = minQty > 0 ? minQty : 1;
  const qty = floorToStep(usd / price, step);
  if (qty < step) return { ok: false, reason: `$${usd.toFixed(2)} buys less than the market minimum of ${step} contract(s) at ${price}` };
  return { ok: true, qty, usd: Number((qty * price).toFixed(4)) };
}

/** Which tier a whale stake falls in: 0 below the first threshold, 1 above it, and so on. */
export function tierOf(stakeUsd: number, thresholds: number[]): number {
  let t = 0;
  for (const th of thresholds) if (stakeUsd >= th) t++;
  return t;
}

/**
 * whale_tier sizing: the bet should total bankroll x PCT_PER_TRADE x the tier's multiplier
 * (kept within MIN_ORDER_USD..MAX_ORDER_USD). Returns how much more to buy on top of `heldUsd`.
 */
export function tierOrder(
  cfg: Pick<Config, 'USER_BANKROLL_USD' | 'PCT_PER_TRADE' | 'MIN_ORDER_USD' | 'MAX_ORDER_USD' | 'TIER_THRESHOLDS_USD' | 'TIER_MULTIPLIERS'>,
  stakeUsd: number,
  heldUsd: number,
  price: number,
  minQty: number,
  openExposureUsd: number,
): (SizeResult & { tier: number; targetUsd: number }) {
  const tier = tierOf(stakeUsd, cfg.TIER_THRESHOLDS_USD);
  const mult = cfg.TIER_MULTIPLIERS[tier] ?? cfg.TIER_MULTIPLIERS.at(-1)!;
  const targetUsd = Math.min(Math.max(cfg.USER_BANKROLL_USD * cfg.PCT_PER_TRADE * mult, cfg.MIN_ORDER_USD), cfg.MAX_ORDER_USD);
  const fail = (reason: string) => ({ ok: false as const, reason, tier, targetUsd });
  if (!(price > 0 && price < 1)) return fail(`bad price ${price}`);
  let usd = targetUsd - heldUsd;
  if (usd < cfg.MIN_ORDER_USD) return fail(`already have $${heldUsd.toFixed(2)} on this bet (tier ${tier} target $${targetUsd.toFixed(2)})`);
  const free = cfg.USER_BANKROLL_USD - openExposureUsd;
  if (free < cfg.MIN_ORDER_USD) return fail(`bankroll fully used ($${openExposureUsd.toFixed(2)} of $${cfg.USER_BANKROLL_USD.toFixed(2)} in open copies)`);
  usd = Math.min(usd, free);
  const step = minQty > 0 ? minQty : 1;
  const qty = floorToStep(usd / price, step);
  if (qty < step) return fail(`$${usd.toFixed(2)} buys less than the market minimum of ${step} contract(s) at ${price}`);
  return { ok: true, qty, usd: Number((qty * price).toFixed(4)), tier, targetUsd };
}

type ScaleCfg = Pick<Config, 'USER_BANKROLL_USD' | 'MAX_PER_MARKET_USD' | 'MAX_PER_GAME_USD' | 'COMPOUND_BANKROLL'> & Partial<Pick<Config, 'ADDED_FUNDS_USD'>>;

/**
 * With COMPOUND_BANKROLL on, the bankroll is the starting USER_BANKROLL_USD plus everything won or lost
 * on finished copies (plus ADDED_FUNDS_USD, money deposited later, which is not profit), so bets grow and shrink with it. The per-market and per-game caps scale by the
 * same factor (so they keep allowing one bet per game); MIN_ORDER_USD and MAX_ORDER_USD stay fixed.
 */
export function scaledForBankroll<C extends ScaleCfg>(cfg: C, realizedPnlUsd: number): C & { bankrollScale: number } {
  const added = cfg.ADDED_FUNDS_USD ?? 0;
  if (!cfg.COMPOUND_BANKROLL && !added) return { ...cfg, bankrollScale: 1 };
  const bankroll = Math.max(0, cfg.USER_BANKROLL_USD + added + (cfg.COMPOUND_BANKROLL ? realizedPnlUsd : 0));
  const scale = cfg.USER_BANKROLL_USD > 0 ? bankroll / cfg.USER_BANKROLL_USD : 1;
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    ...cfg,
    USER_BANKROLL_USD: r(bankroll),
    MAX_PER_MARKET_USD: r(cfg.MAX_PER_MARKET_USD * scale),
    MAX_PER_GAME_USD: r(cfg.MAX_PER_GAME_USD * scale),
    bankrollScale: scale,
  };
}

/** Exit size: the same fraction of our copy as the fraction of the whale's copied shares they sold. */
export function exitQty(ourQty: number, whaleSharesTracked: number, whaleSharesSold: number, minQty: number): number {
  const frac = whaleSharesTracked > 0 ? Math.min(1, whaleSharesSold / whaleSharesTracked) : 1;
  if (frac >= 0.98) return ourQty; // basically everything: sell it all, no dust left over
  const step = minQty > 0 ? minQty : 1;
  return Math.min(ourQty, floorToStep(ourQty * frac, step));
}
