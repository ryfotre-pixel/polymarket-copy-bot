import type { UsBbo, UsSide } from './types.ts';

// All prices here are "our side" prices: what one contract of the side we hold costs, 0..1.
// Polymarket US quotes everything from the LONG (YES) side, so for SHORT:
//   price to buy SHORT  = 1 - best LONG bid
//   price to sell SHORT = 1 - best LONG ask
// (Verified live: BBO shortQuote 0.34 == 1 - bestBid 0.66.)

const EPS = 1e-9;

export const toTicks = (p: number, tick: number) => Math.round(p / tick);
export const decimalsOf = (tick: number) => Math.max(0, (tick.toString().split('.')[1] ?? '').length);
export const fmtPrice = (p: number, tick: number) => p.toFixed(decimalsOf(tick));

export function roundToTick(p: number, tick: number, mode: 'up' | 'down'): number {
  const n = p / tick;
  const fuzz = 1e-6; // in ticks: absorbs float noise like 0.675000001 without skipping a real tick
  const t = mode === 'up' ? Math.ceil(n - fuzz) : Math.floor(n + fuzz);
  return Number((t * tick).toFixed(decimalsOf(tick)));
}

const num = (a: { value: string } | null | undefined) => (a?.value !== undefined ? Number(a.value) : undefined);

/** Best price we could buy / sell our side at right now, from the US BBO. */
export function sidePrices(bbo: UsBbo, side: UsSide): { buy?: number; sell?: number } {
  const bid = num(bbo.bestBid);
  const ask = num(bbo.bestAsk);
  if (side === 'LONG') return { buy: ask, sell: bid };
  return { buy: bid !== undefined ? 1 - bid : undefined, sell: ask !== undefined ? 1 - ask : undefined };
}

/**
 * The order API takes the limit price in LONG/YES terms for every intent
 * ("the price always refers to the YES side" - docs.polymarket.us/concepts/orders).
 * CHECK THIS with orders.preview before going live (see README).
 */
export const toOrderPrice = (sidePrice: number, side: UsSide) => (side === 'LONG' ? sidePrice : 1 - sidePrice);

export type GuardResult =
  | { ok: true; marketPrice: number; limitPrice: number; slippage: number }
  | { ok: false; reason: string; marketPrice?: number };

/**
 * Entry check: is the US price close enough to what the whale paid?
 * Limit = market price + 1 tick (crosses the spread for an instant fill),
 * but never above whalePrice + maxSlippage.
 */
export function checkEntry(bbo: UsBbo, side: UsSide, whalePrice: number, maxSlippage: number, tick: number): GuardResult {
  if (bbo.state && bbo.state !== 'MARKET_STATE_OPEN') return { ok: false, reason: `market is ${bbo.state.replace('MARKET_STATE_', '').toLowerCase()}` };
  const buy = sidePrices(bbo, side).buy;
  if (buy === undefined || !(buy > 0 && buy < 1)) return { ok: false, reason: 'no sellers on US right now' };
  const slippage = buy - whalePrice;
  if (slippage > maxSlippage + EPS) {
    return { ok: false, marketPrice: buy, reason: `US price ${buy.toFixed(3)} is ${(slippage * 100).toFixed(1)}c worse than whale's ${whalePrice.toFixed(3)} (max ${(maxSlippage * 100).toFixed(1)}c)` };
  }
  const cap = roundToTick(whalePrice + maxSlippage, tick, 'down');
  const limit = Math.min(roundToTick(buy + tick, tick, 'up'), Math.max(cap, roundToTick(buy, tick, 'up')), 1 - tick);
  return { ok: true, marketPrice: buy, limitPrice: limit, slippage };
}

/** Exit: sell into the best bid, limit 1 tick below so it fills immediately. */
export function checkExit(bbo: UsBbo, side: UsSide, tick: number): GuardResult {
  if (bbo.state && bbo.state !== 'MARKET_STATE_OPEN') return { ok: false, reason: `market is ${bbo.state.replace('MARKET_STATE_', '').toLowerCase()}` };
  const sell = sidePrices(bbo, side).sell;
  if (sell === undefined || !(sell > 0 && sell < 1)) return { ok: false, reason: 'no buyers on US right now' };
  const limit = Math.max(tick, roundToTick(sell - tick, tick, 'down'));
  return { ok: true, marketPrice: sell, limitPrice: limit, slippage: 0 };
}
