// Shapes of the real API responses (checked against live data on 2026-11-03).
// The polymarket-us SDK's own types are incomplete for market data, so public
// market data is read with fetch() using these types instead.

/** One item from GET https://data-api.polymarket.com/v2/activity (international). */
export interface IntlActivity {
  proxy_wallet: string;
  timestamp: number; // unix seconds
  condition_id: string;
  type: string; // TRADE, REDEEM, SPLIT, MERGE, ...
  size: number; // shares
  usdc_size: number; // dollars
  transaction_hash: string;
  price: number; // 0..1, price of the outcome token traded
  token_id: string;
  side: 'BUY' | 'SELL';
  outcome_index: number;
  title: string;
  slug: string;
  event_slug: string;
  outcome: string;
}

export interface IntlActivityPage {
  data: IntlActivity[];
  pagination?: { next_cursor?: string | null; has_more?: boolean };
}

export interface UsTeam {
  name?: string;
  abbreviation?: string;
  alias?: string;
  safeName?: string;
}

export interface UsMarketSide {
  long: boolean;
  description?: string;
  team?: UsTeam;
}

export interface UsMarket {
  slug: string;
  question?: string;
  sportsMarketType?: string;
  line?: number;
  active?: boolean;
  closed?: boolean;
  status?: string;
  orderPriceMinTickSize?: number;
  minimumTradeQty?: number;
  marketSides?: UsMarketSide[];
}

export interface UsEvent {
  slug: string;
  title?: string;
  startTime?: string;
  active?: boolean;
  closed?: boolean;
  ended?: boolean;
  markets?: UsMarket[];
}

export interface UsAmount {
  value: string;
  currency?: string;
}

/** GET https://gateway.polymarket.us/v1/markets/{slug}/bbo -> { marketData } */
export interface UsBbo {
  marketSlug: string;
  bestBid?: UsAmount | null;
  bestAsk?: UsAmount | null;
  bidDepth?: number;
  askDepth?: number;
  state?: string; // MARKET_STATE_OPEN, MARKET_STATE_EXPIRED, ...
  settlementPx?: UsAmount | null; // set once the game is settled: the LONG side's final value (1 or 0)
}

/** Which side of a US market we hold. LONG = the market's "long" side (YES / first team / Over). */
export type UsSide = 'LONG' | 'SHORT';
