import { getJson } from './http.ts';
import type { IntlActivity, IntlActivityPage } from './types.ts';

const ACTIVITY_URL = 'https://data-api.polymarket.com/v2/activity';
const PAGE_SIZE = 50;
const MAX_PAGES = 5;

/** Unique key for one whale fill (one transaction can contain several fills). */
export const tradeKey = (t: IntlActivity) => `${t.transaction_hash}:${t.token_id}:${t.side}:${t.size}:${t.price}`;

/**
 * Fetch the whale's TRADE activity newer than `sinceSec`, oldest first.
 * Follows next_cursor so a burst of trades between polls isn't missed.
 */
export async function fetchNewTrades(wallet: string, sinceSec: number, isSeen: (key: string) => boolean): Promise<IntlActivity[]> {
  const out: IntlActivity[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${ACTIVITY_URL}?user=${wallet}&type=TRADE&limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await getJson<IntlActivityPage>(url);
    const items = res.data ?? [];
    let reachedOld = false;
    for (const t of items) {
      if (t.timestamp < sinceSec) {
        reachedOld = true;
        continue;
      }
      if (t.type !== 'TRADE' || isSeen(tradeKey(t))) continue;
      out.push(t);
    }
    cursor = res.pagination?.next_cursor ?? undefined;
    if (reachedOld || !cursor || !res.pagination?.has_more) break;
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
