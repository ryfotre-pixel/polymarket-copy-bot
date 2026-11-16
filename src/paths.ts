import 'dotenv/config';
import { join } from 'node:path';

/**
 * Folder for this bot's state, log and heartbeat. The live bot uses `data`; a second dry-run bot
 * (e.g. `npm run dry:sized`) uses its own folder so the two never touch each other's files.
 */
export const DATA_DIR = (process.env.DATA_DIR ?? '').trim() || 'data';
export const STATE_FILE = join(DATA_DIR, 'state.json');
export const LOG_FILE = join(DATA_DIR, 'trades.log');
export const HEARTBEAT_FILE = join(DATA_DIR, 'heartbeat.json');
