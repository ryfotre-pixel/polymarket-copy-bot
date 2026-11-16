import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { STATE_FILE } from './paths.ts';
import type { UsSide } from './types.ts';

/** A position this bot opened by copying the whale. The bot never touches positions you opened yourself. */
export interface CopiedPosition {
  usSlug: string;
  side: UsSide;
  qty: number; // contracts we hold
  costUsd: number; // dollars we paid in total
  whaleTokenId: string; // the whale's outcome token we are mirroring
  whaleShares: number; // whale shares bought while we were copying (for proportional exits)
  tick: number; // market's orderPriceMinTickSize
  minQty: number; // market's minimumTradeQty
  openedAt: string;
  tier?: number; // whale_tier sizing: the tier this position has been sized to
  label?: string; // human description for messages, e.g. "Canadiens · Canadiens vs. Bruins"
}

/** Running scoreboard of copies that are finished (settled games and sells). */
export interface Results {
  settled: number;
  wins: number;
  losses: number;
  realizedPnlUsd: number;
}

/** How much more than the whale we paid, over all our buys that filled. */
export interface EntryStats {
  fills: number;
  slipSum: number; // sum of (our fill price - whale price), in dollars per contract
}

export interface BotState {
  version: 1;
  /** Keys of whale trades already handled (newest last). */
  seen: string[];
  /** One position per US market (key: usSlug). We never hold both sides of one market. */
  positions: Record<string, CopiedPosition>;
  results?: Results;
  entry?: EntryStats;
  /** Running total of whale dollars per outcome token, small trades included (for whale_tier sizing). */
  whaleStake?: Record<string, { usd: number; lastAt: number }>;
}

const MAX_SEEN = 5000;

export class StateStore {
  private state: BotState;
  private seenSet: Set<string>;

  constructor(private readonly file = STATE_FILE) {
    this.state = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as BotState) : { version: 1, seen: [], positions: {} };
    this.state.results ??= { settled: 0, wins: 0, losses: 0, realizedPnlUsd: 0 };
    this.state.entry ??= { fills: 0, slipSum: 0 };
    this.state.whaleStake ??= {};
    this.seenSet = new Set(this.state.seen);
  }

  hasSeen(key: string): boolean {
    return this.seenSet.has(key);
  }

  markSeen(key: string): void {
    if (this.seenSet.has(key)) return;
    this.seenSet.add(key);
    this.state.seen.push(key);
    if (this.state.seen.length > MAX_SEEN) {
      for (const old of this.state.seen.splice(0, this.state.seen.length - MAX_SEEN)) this.seenSet.delete(old);
    }
    this.save();
  }

  get positions(): Record<string, CopiedPosition> {
    return this.state.positions;
  }

  get results(): Results {
    return this.state.results!;
  }

  get entry(): EntryStats {
    return this.state.entry!;
  }

  /** Remember how much more than the whale we paid on a filled buy. */
  recordFill(ourPrice: number, whalePrice: number): void {
    this.entry.fills += 1;
    this.entry.slipSum = round(this.entry.slipSum + (ourPrice - whalePrice));
    this.save();
  }

  /**
   * Add a whale buy to the running total for its outcome and return the new total.
   * Totals untouched for 3 days are dropped. Not saved here; the caller's next markSeen saves it.
   */
  addWhaleStake(tokenId: string, usd: number, atSec: number): number {
    const m = this.state.whaleStake!;
    const cur = m[tokenId] ?? { usd: 0, lastAt: atSec };
    cur.usd = round(cur.usd + usd);
    cur.lastAt = Math.max(cur.lastAt, atSec);
    m[tokenId] = cur;
    for (const [k, v] of Object.entries(m)) if (atSec - v.lastAt > 3 * 86400) delete m[k];
    return cur.usd;
  }

  /** Change the tier recorded on a position after a top-up. */
  setTier(usSlug: string, tier: number): void {
    const p = this.state.positions[usSlug];
    if (p) { p.tier = tier; this.save(); }
  }

  /** Dollars currently tied up in copied positions. */
  openExposureUsd(): number {
    return Object.values(this.state.positions).reduce((s, p) => s + p.costUsd, 0);
  }

  /** Dollars in all copied markets of one game (moneyline, spreads and totals together). */
  gameExposureUsd(usSlug: string): number {
    const game = gameOf(usSlug);
    return Object.values(this.state.positions).reduce((s, p) => (gameOf(p.usSlug) === game ? s + p.costUsd : s), 0);
  }

  findByWhaleToken(tokenId: string): CopiedPosition | undefined {
    return Object.values(this.state.positions).find((p) => p.whaleTokenId === tokenId);
  }

  addBuy(p: Omit<CopiedPosition, 'openedAt'>): void {
    const cur = this.state.positions[p.usSlug];
    if (cur && cur.side !== p.side) {
      // index.ts skips these before ordering; refuse here too so a position is never silently overwritten.
      throw new Error(`already hold ${cur.side} in ${p.usSlug}; refusing to record a ${p.side} buy over it`);
    }
    if (cur) {
      cur.qty = round(cur.qty + p.qty);
      cur.costUsd = round(cur.costUsd + p.costUsd);
      cur.whaleShares += p.whaleShares;
    } else {
      this.state.positions[p.usSlug] = { ...p, openedAt: new Date().toISOString() };
    }
    this.save();
  }

  /** Record a sell. Returns the profit/loss on the part sold. */
  reduce(usSlug: string, qtySold: number, whaleSharesSold: number, proceedsUsd: number): number {
    const cur = this.state.positions[usSlug];
    if (!cur) return 0;
    const frac = cur.qty > 0 ? Math.min(1, qtySold / cur.qty) : 1;
    const pnl = round(proceedsUsd - cur.costUsd * frac);
    cur.qty = round(cur.qty - qtySold);
    cur.costUsd = round(cur.costUsd * (1 - frac));
    cur.whaleShares = Math.max(0, cur.whaleShares - whaleSharesSold);
    if (cur.qty <= 1e-9) delete this.state.positions[usSlug];
    this.results.realizedPnlUsd = round(this.results.realizedPnlUsd + pnl);
    this.save();
    return pnl;
  }

  /**
   * The game is over and the market settled. `longValue` is what one LONG contract paid out (1 or 0);
   * a SHORT contract pays 1 - longValue. Removes the position and returns its profit/loss.
   */
  settle(usSlug: string, longValue: number): { pnl: number; payout: number; position: CopiedPosition } | undefined {
    const cur = this.state.positions[usSlug];
    if (!cur) return undefined;
    const perContract = cur.side === 'LONG' ? longValue : 1 - longValue;
    const payout = round(cur.qty * perContract);
    const pnl = round(payout - cur.costUsd);
    delete this.state.positions[usSlug];
    const r = this.results;
    r.settled += 1;
    if (pnl > 0) r.wins += 1;
    else if (pnl < 0) r.losses += 1;
    r.realizedPnlUsd = round(r.realizedPnlUsd + pnl);
    this.save();
    return { pnl, payout, position: cur };
  }

  /** Write to a temp file then rename, so a crash mid-write can't corrupt the state. */
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    renameSync(tmp, this.file);
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** "tsc-nba-uta-no-2026-11-04-233pt5" -> "nba-uta-no-2026-11-04" (US slugs are <type>-<game>[-<line>]). */
export function gameOf(usSlug: string): string {
  return usSlug.match(/^[a-z]+-(.+?-\d{4}-\d{2}-\d{2})/)?.[1] ?? usSlug;
}
