// Checks that the Polymarket US API keys in .env work, by reading the account balance.
// Read-only: places no orders. Never prints the keys.
//   npx tsx tools/check-keys.ts
import 'dotenv/config';
import { PolymarketUS } from 'polymarket-us';

const keyId = process.env.POLYMARKET_KEY_ID ?? '';
const secretKey = process.env.POLYMARKET_SECRET_KEY ?? '';
if (!keyId || !secretKey) {
  console.log('POLYMARKET_KEY_ID or POLYMARKET_SECRET_KEY is empty in .env');
  process.exit(1);
}
const client = new PolymarketUS({ keyId, secretKey, timeout: 15_000 });
try {
  const r = await client.account.balances();
  console.log('Keys work. Account balances:');
  console.log(JSON.stringify(r, null, 2));
} catch (e) {
  const err = e as { status?: number; message?: string };
  console.log(`Keys did not work: ${err.status ?? ''} ${err.message ?? String(e)}`);
  process.exit(1);
}
