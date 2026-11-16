import { PolymarketUS, type CreateOrderParams, type CreateOrderResponse, type OrderIntent } from 'polymarket-us';
import type { Config } from './config.ts';
import { getJson } from './http.ts';
import { warn } from './log.ts';
import { fmtPrice, toOrderPrice } from './pricing.ts';
import type { UsBbo, UsSide } from './types.ts';

const US_GATEWAY = 'https://gateway.polymarket.us';

export async function getBbo(slug: string): Promise<UsBbo> {
  const res = await getJson<{ marketData: UsBbo }>(`${US_GATEWAY}/v1/markets/${encodeURIComponent(slug)}/bbo`);
  return res.marketData;
}

export interface OrderRequest {
  usSlug: string;
  side: UsSide;
  action: 'BUY' | 'SELL';
  qty: number;
  limitPrice: number; // our-side price
  tick: number;
}

/**
 * Sending a real order failed in a way where it may still have reached the exchange (timeout, dropped
 * connection). The trade must not be retried, or we could buy twice.
 */
export class OrderUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderUncertainError';
  }
}

export interface Fill {
  simulated: boolean;
  orderId?: string;
  filledQty: number;
  avgPrice: number; // our-side price
  feeUsd?: number; // exchange commission charged on this order
  note?: string;
}

const intentFor = (action: 'BUY' | 'SELL', side: UsSide): OrderIntent =>
  `ORDER_INTENT_${action}_${side}` as OrderIntent;

export function buildOrder(req: OrderRequest): CreateOrderParams {
  return {
    marketSlug: req.usSlug,
    intent: intentFor(req.action, req.side),
    type: 'ORDER_TYPE_LIMIT',
    price: { value: fmtPrice(toOrderPrice(req.limitPrice, req.side), req.tick), currency: 'USD' },
    quantity: req.qty,
    // Fill what's available now, cancel the rest: nothing is left resting on the book.
    tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    // Tell the exchange honestly that this order came from software.
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    synchronousExecution: true,
  };
}

export class Executor {
  private readonly client?: PolymarketUS;

  constructor(private readonly cfg: Config) {
    if (cfg.POLYMARKET_KEY_ID && cfg.POLYMARKET_SECRET_KEY) {
      this.client = new PolymarketUS({ keyId: cfg.POLYMARKET_KEY_ID, secretKey: cfg.POLYMARKET_SECRET_KEY, timeout: 15_000 });
    }
  }

  get hasKeys(): boolean {
    return !!this.client;
  }

  /** Dollars available to trade on Polymarket US (needs keys). */
  async buyingPower(): Promise<number | undefined> {
    if (!this.client) return undefined;
    const res = await this.client.account.balances();
    return res.balances.find((b) => b.currency === 'USD')?.buyingPower ?? res.balances[0]?.buyingPower;
  }

  async place(req: OrderRequest): Promise<Fill> {
    const params = buildOrder(req);

    if (this.cfg.DRY_RUN) {
      let note = 'simulated fill at limit price';
      if (this.client) {
        try {
          const preview = await this.client.orders.preview({ request: params });
          note = `exchange preview OK (state ${preview.order?.state ?? '?'}, price ${preview.order?.price?.value ?? '?'})`;
        } catch (e) {
          note = `exchange preview REJECTED: ${(e as Error).message}`;
        }
      }
      return { simulated: true, filledQty: req.qty, avgPrice: req.limitPrice, note };
    }

    if (!this.client) throw new Error('live mode without API keys');
    let res: CreateOrderResponse;
    try {
      res = await this.client.orders.create(params);
    } catch (e) {
      throw new OrderUncertainError(`sending the ${req.action} order for ${req.usSlug} failed: ${(e as Error).message}`);
    }
    return { simulated: false, orderId: res.id, ...(await this.readFill(res, req)) };
  }

  /**
   * Work out how much actually filled. The exchange's own order record is the source of truth.
   * Note: every execution carries orderRejectReason, even fills (it defaults to EXCHANGE_OPTION),
   * so only an execution of type REJECTED counts as a rejection.
   */
  private async readFill(res: CreateOrderResponse, req: OrderRequest): Promise<{ filledQty: number; avgPrice: number; feeUsd?: number; note?: string }> {
    const toOurSide = (longPx: number) => (req.side === 'LONG' ? longPx : 1 - longPx);
    if (this.client) {
      try {
        const { order } = await this.client.orders.retrieve(res.id);
        const qty = Number(order.cumQuantity ?? 0);
        const fee = Number(order.commissionNotionalTotalCollected?.value ?? 0) || 0;
        if (qty > 0) {
          const avgLong = Number(order.avgPx?.value ?? toOrderPrice(req.limitPrice, req.side));
          return { filledQty: qty, avgPrice: toOurSide(avgLong), feeUsd: fee, note: `filled (${order.state}), fee $${fee.toFixed(2)}` };
        }
        const rej = (res.executions ?? []).find((ex) => ex.type === 'EXECUTION_TYPE_REJECTED');
        if (rej) return { filledQty: 0, avgPrice: 0, note: `rejected: ${rej.orderRejectReason ?? '?'} ${rej.text ?? ''}`.trim() };
        return { filledQty: 0, avgPrice: 0, note: `nothing filled (${order.state})` };
      } catch (e) {
        warn(`could not look up order ${res.id}: ${(e as Error).message}; using the order reply instead`);
      }
    }
    // Fallback: add up the executions in the order reply.
    let qty = 0;
    let notional = 0;
    let fee = 0;
    for (const ex of res.executions ?? []) {
      if (ex.type === 'EXECUTION_TYPE_REJECTED') return { filledQty: 0, avgPrice: 0, note: `rejected: ${ex.orderRejectReason ?? '?'} ${ex.text ?? ''}`.trim() };
      const shares = Number(ex.lastShares ?? 0);
      const px = Number(ex.lastPx?.value ?? NaN);
      if (shares > 0 && Number.isFinite(px)) {
        qty += shares;
        notional += shares * px;
        fee += Number(ex.commissionNotionalCollected?.value ?? 0) || 0;
      }
    }
    if (qty === 0) return { filledQty: 0, avgPrice: 0, note: 'nothing filled (IOC cancelled)' };
    // Execution prices come back in LONG terms; convert to our side.
    return { filledQty: qty, avgPrice: toOurSide(notional / qty), feeUsd: fee };
  }
}
