// Prints the settings the bot would run with (never prints the API keys, only whether they are set).
//   npx tsx tools/show-config.ts
import { loadConfig } from '../src/config.ts';
import { LOG_FILE, STATE_FILE } from '../src/paths.ts';

try {
  const c = loadConfig();
  const { POLYMARKET_KEY_ID, POLYMARKET_SECRET_KEY, ...rest } = c;
  console.log({ ...rest, apiKeysSet: !!(POLYMARKET_KEY_ID && POLYMARKET_SECRET_KEY), STATE_FILE, LOG_FILE });
} catch (e) {
  console.log((e as Error).message);
  process.exitCode = 1;
}
