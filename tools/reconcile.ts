// One-time repair: finds live buys the bot logged as "rejected" / unfilled, asks Polymarket US what
// really happened to each order, and records the ones that filled as positions the bot tracks.
// Read-only toward the exchange (it only looks orders up). Run it ONLY while the live bot is stopped,
// otherwise the running bot overwrites the repaired state file.
//   npx tsx tools/reconcile.ts            (shows what it would change)
//   npx tsx tools/reconcile.ts --apply    (writes the changes)
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PolymarketUS } from 'polymarket-us';
import { LOG_FILE } from '../src/paths.ts';
import { StateStore } from '../src/state.ts';
import { record } from '../src/log.ts';
import { getUsEvent } from '../src/resolver.ts';

const apply = process.argv.includes('--apply');
const keyId = process.env.POLYMARKET_KEY_ID;
const secretKey = process.env.POLYMARKET_SECRET_KEY;
if (!keyId || !secretKey) {
  console.log('API keys not set in .env');
  process.exit(1);
}
const client = new PolymarketUS({ keyId, secretKey, timeout: 15_000 });
const state = new StateStore();

const log = readFileSync(LOG_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const done = new Set(log.filter((r) => r.reconciled).map((r) => r.fill?.orderId));
const suspects = log.filter((r) => r.event === 'buy' && r.fill?.orderId && !(r.fill.filledQty > 0) && !done.has(r.fill.orderId));
console.log(`${suspects.length} live buy(s) logged as not filled. Checking each with Polymarket US...`);

let fixed = 0;
for (const r of suspects) {
  const { order } = await client.orders.retrieve(r.fill.orderId);
  const qty = Number(order.cumQuantity ?? 0);
  if (!(qty > 0)) {
    console.log(`  ${r.fill.orderId} ${r.usSlug}: really not filled (${order.state})`);
    continue;
  }
  const avgLong = Number(order.avgPx?.value);
  const avgPrice = r.side === 'LONG' ? avgLong : 1 - avgLong;
  const feeUsd = Number(order.commissionNotionalTotalCollected?.value ?? 0) || 0;
  const costUsd = qty * avgPrice + feeUsd;
  const ev = order.marketMetadata?.eventSlug ? await getUsEvent(order.marketMetadata.eventSlug) : null;
  const mk = ev?.markets?.find((m) => m.slug === r.usSlug);
  const tick = Number(mk?.orderPriceMinTickSize ?? 0.01);
  const minQty = Number(mk?.minimumTradeQty ?? 0.01);
  console.log(`  ${r.fill.orderId} ${r.usSlug} ${r.side}: FILLED ${qty} @ ${avgPrice.toFixed(3)} + fee $${feeUsd.toFixed(2)} = $${costUsd.toFixed(2)}` +
    ` (${r.whale?.title}: ${r.whale?.outcome}; whale paid ${Number(r.whale?.price).toFixed(3)})`);
  if (!apply) continue;
  state.addBuy({ usSlug: r.usSlug, side: r.side, qty, costUsd, whaleTokenId: r.whale.token_id, whaleShares: r.whale.size, tick, minQty });
  state.recordFill(avgPrice, r.whale.price);
  const fill = { simulated: false, orderId: r.fill.orderId, filledQty: qty, avgPrice, feeUsd, note: `filled (${order.state}); repaired by tools/reconcile.ts` };
  record('buy', { usSlug: r.usSlug, side: r.side, qty: r.qty, limit: r.limit, fill, whale: r.whale, reconciled: true, originalAt: r.at });
  fixed++;
}
if (apply) console.log(`Recorded ${fixed} filled buy(s). Open copies now $${state.openExposureUsd().toFixed(2)}.`);
else console.log('Nothing written. Stop the live bot first, then run again with --apply.');
