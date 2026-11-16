import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : /^(1|true|yes|on)$/i.test(v.trim())));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: 'custom', message: `"${v}" is not a number` });
        return z.NEVER;
      }
      return n;
    });

const numList = (def: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const parts = (v === undefined || v.trim() === '' ? def : v).split(',').map((s) => Number(s.trim()));
      if (parts.some((n) => !Number.isFinite(n))) {
        ctx.addIssue({ code: 'custom', message: `"${v}" must be numbers separated by commas` });
        return z.NEVER;
      }
      return parts;
    });

export const MARKET_KIND_VALUES = ['moneyline', 'spread', 'total', 'soccer_winner'] as const;
export type MarketKind = (typeof MARKET_KIND_VALUES)[number];

const schema = z
  .object({
    TARGET_PROXY_WALLET: z
      .string({ error: 'TARGET_PROXY_WALLET is missing in .env' })
      .trim()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'TARGET_PROXY_WALLET must be a 0x... wallet address (42 characters)'),
    DRY_RUN: bool(true),
    POLYMARKET_KEY_ID: z.string().trim().optional().transform((v) => v || undefined),
    POLYMARKET_SECRET_KEY: z.string().trim().optional().transform((v) => v || undefined),
    USER_BANKROLL_USD: num(90),
    // Money added to (or, negative, taken out of) the account after the start. Bets size from it,
    // but it is never counted as profit or loss.
    ADDED_FUNDS_USD: z.coerce.number().default(0),
    COMPOUND_BANKROLL: bool(true),
    SIZING_MODE: z.enum(['fixed_pct', 'whale_ratio', 'whale_tier']).default('fixed_pct'),
    // whale_tier: bet size depends on how much the whale has put on that bet so far.
    TIER_THRESHOLDS_USD: numList('3000,8000'),
    TIER_MULTIPLIERS: numList('0.5,1,2'),
    TOP_UP_WINDOW_SEC: num(600),
    DATA_DIR: z.string().optional().transform((v) => (v ?? '').trim() || 'data'),
    PCT_PER_TRADE: num(0.05),
    WHALE_BANKROLL_USD: num(50000),
    MIN_ORDER_USD: num(1),
    MAX_ORDER_USD: num(10),
    MAX_PER_MARKET_USD: num(10),
    MAX_PER_GAME_USD: num(10),
    MIN_WHALE_TRADE_USD: num(50),
    MAX_SLIPPAGE_CENTS: num(0.03),
    MAX_TRADE_AGE_SEC: num(90),
    MAX_LOSS_USD: num(40),
    MAX_AVG_SLIPPAGE_CENTS: num(0.025),
    SLIPPAGE_MIN_FILLS: num(10),
    MARKET_KINDS: z
      .string()
      .default(MARKET_KIND_VALUES.join(','))
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
      .pipe(z.array(z.enum(MARKET_KIND_VALUES))),
    // League codes from the start of the event slug (nba, epl, ...). Empty = every league.
    LEAGUES: z
      .string()
      .default("")
      .transform((v) => v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
    COPY_EXITS: bool(true),
    // Phone notifications (live bot only): subscribe to this topic in the ntfy app. Empty = off.
    NTFY_TOPIC: z.string().optional().transform((v) => (v ?? '').trim()),
    NTFY_SERVER: z.string().optional().transform((v) => (v ?? '').trim() || 'https://ntfy.sh'),
    POLL_MS: num(2500),
    SETTLE_CHECK_MS: num(60000),
  })
  .superRefine((c, ctx) => {
    if (!c.DRY_RUN && (!c.POLYMARKET_KEY_ID || !c.POLYMARKET_SECRET_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'DRY_RUN=false needs POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY' });
    }
    if (!c.DRY_RUN && c.DATA_DIR !== 'data') {
      ctx.addIssue({ code: 'custom', message: `live trading only runs from the data folder; DATA_DIR=${c.DATA_DIR} is for dry runs` });
    }
    if (c.SIZING_MODE === 'whale_tier') {
      const t = c.TIER_THRESHOLDS_USD, m = c.TIER_MULTIPLIERS;
      if (t.some((x, i) => i > 0 && x <= t[i - 1]!)) ctx.addIssue({ code: 'custom', message: 'TIER_THRESHOLDS_USD must go up, e.g. 3000,8000' });
      if (m.length !== t.length + 1) ctx.addIssue({ code: 'custom', message: `TIER_MULTIPLIERS needs ${t.length + 1} numbers (one more than TIER_THRESHOLDS_USD)` });
      if (m.some((x) => x <= 0)) ctx.addIssue({ code: 'custom', message: 'TIER_MULTIPLIERS must be above 0' });
    }
    if (c.PCT_PER_TRADE <= 0 || c.PCT_PER_TRADE > 1) ctx.addIssue({ code: 'custom', message: 'PCT_PER_TRADE must be between 0 and 1 (0.05 = 5%)' });
    if (c.MIN_ORDER_USD > c.MAX_ORDER_USD) ctx.addIssue({ code: 'custom', message: 'MIN_ORDER_USD is bigger than MAX_ORDER_USD' });
    if (c.MAX_SLIPPAGE_CENTS < 0 || c.MAX_SLIPPAGE_CENTS >= 1) ctx.addIssue({ code: 'custom', message: 'MAX_SLIPPAGE_CENTS is in dollars, e.g. 0.03' });
    if (c.MAX_PER_GAME_USD < c.MIN_ORDER_USD) ctx.addIssue({ code: 'custom', message: 'MAX_PER_GAME_USD is smaller than MIN_ORDER_USD' });
    if (c.MAX_PER_MARKET_USD < c.MIN_ORDER_USD) ctx.addIssue({ code: 'custom', message: 'MAX_PER_MARKET_USD is smaller than MIN_ORDER_USD' });
    if (c.MAX_LOSS_USD < 0) ctx.addIssue({ code: 'custom', message: 'MAX_LOSS_USD must be 0 (off) or more' });
    if (c.MAX_AVG_SLIPPAGE_CENTS < 0 || c.MAX_AVG_SLIPPAGE_CENTS >= 1) ctx.addIssue({ code: 'custom', message: 'MAX_AVG_SLIPPAGE_CENTS is in dollars, e.g. 0.025 (0 = off)' });
    if (c.SLIPPAGE_MIN_FILLS < 1) ctx.addIssue({ code: 'custom', message: 'SLIPPAGE_MIN_FILLS must be at least 1' });
    if (c.POLL_MS < 1000) ctx.addIssue({ code: 'custom', message: 'POLL_MS must be at least 1000' });
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.message}`).join('\n');
    throw new Error(`Your .env settings have a problem:\n${lines}\n(See .env.example for every setting.)`);
  }
  return parsed.data;
}
