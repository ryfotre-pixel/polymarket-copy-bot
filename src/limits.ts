import type { Config } from './config.ts';
import type { EntryStats, Results } from './state.ts';

export type LimitCfg = Pick<Config, 'MAX_LOSS_USD' | 'MAX_AVG_SLIPPAGE_CENTS' | 'SLIPPAGE_MIN_FILLS'>;

const money = (n: number) => `$${n.toFixed(2)}`;
const cents = (n: number) => `${(n * 100).toFixed(1)}c`;

/**
 * Why the bot should stop opening new copies, or undefined if it may keep going.
 * Worked out from saved results every time, so it survives restarts, and raising a limit in .env resumes trading.
 */
export function haltReason(cfg: LimitCfg, results: Results, entry: EntryStats): string | undefined {
  if (cfg.MAX_LOSS_USD > 0 && results.realizedPnlUsd <= -cfg.MAX_LOSS_USD) {
    return `loss limit reached: finished copies are down ${money(-results.realizedPnlUsd)} (MAX_LOSS_USD is ${money(cfg.MAX_LOSS_USD)})`;
  }
  if (cfg.MAX_AVG_SLIPPAGE_CENTS > 0 && entry.fills >= cfg.SLIPPAGE_MIN_FILLS) {
    const avg = entry.slipSum / entry.fills;
    if (avg > cfg.MAX_AVG_SLIPPAGE_CENTS) {
      return `copy cost too high: over ${entry.fills} fills we paid on average ${cents(avg)} more than the whale (MAX_AVG_SLIPPAGE_CENTS is ${cents(cfg.MAX_AVG_SLIPPAGE_CENTS)})`;
    }
  }
  return undefined;
}

/**
 * A new copy is allowed only if, even if every open copy and this new one lost completely,
 * total losses would stay within MAX_LOSS_USD. So the limit is a hard ceiling, not just a trigger.
 */
export function lossRoomCheck(cfg: LimitCfg, results: Results, openExposureUsd: number, orderUsd: number): { ok: true } | { ok: false; reason: string } {
  if (cfg.MAX_LOSS_USD <= 0) return { ok: true };
  const worst = -results.realizedPnlUsd + openExposureUsd + orderUsd;
  if (worst > cfg.MAX_LOSS_USD + 1e-9) {
    return {
      ok: false,
      reason: `loss limit: if this and all ${money(openExposureUsd)} of open copies lost, total loss would be ${money(worst)} (MAX_LOSS_USD is ${money(cfg.MAX_LOSS_USD)})`,
    };
  }
  return { ok: true };
}

export function avgSlippage(entry: EntryStats): number | undefined {
  return entry.fills ? entry.slipSum / entry.fills : undefined;
}
