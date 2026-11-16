import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOG_FILE } from './paths.ts';
mkdirSync(dirname(LOG_FILE), { recursive: true });

const time = () => new Date().toLocaleTimeString();

/** Plain-English line on screen. */
export function say(msg: string): void {
  console.log(`[${time()}] ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`[${time()}] WARNING: ${msg}`);
}

/** Machine-readable record of every decision, one JSON object per line, in <DATA_DIR>/trades.log. */
export function record(event: string, details: Record<string, unknown>): void {
  try {
    appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n');
  } catch (e) {
    warn(`could not write ${LOG_FILE}: ${(e as Error).message}`);
  }
}
