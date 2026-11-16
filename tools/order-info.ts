// Looks up orders by id (read-only; never places anything, never prints the keys).
//   npx tsx tools/order-info.ts <orderId> [orderId...]
import 'dotenv/config';
import { PolymarketUS } from 'polymarket-us';

const keyId = process.env.POLYMARKET_KEY_ID;
const secretKey = process.env.POLYMARKET_SECRET_KEY;
if (!keyId || !secretKey) {
  console.log('API keys not set in .env');
  process.exit(1);
}
const client = new PolymarketUS({ keyId, secretKey, timeout: 15_000 });
for (const id of process.argv.slice(2)) {
  try {
    const res = await client.orders.retrieve(id);
    console.log(id, JSON.stringify(res, null, 1));
  } catch (e) {
    console.log(id, 'lookup failed:', (e as Error).message);
  }
}
