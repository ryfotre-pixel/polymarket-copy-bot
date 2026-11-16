import type { MarketKind } from './config.ts';
import { getJson, HttpError } from './http.ts';
import type { IntlActivity, UsEvent, UsMarket, UsMarketSide, UsSide } from './types.ts';

const US_GATEWAY = 'https://gateway.polymarket.us';

// ---------------------------------------------------------------------------
// 1. Understand the international trade
// ---------------------------------------------------------------------------

export type IntlBet =
  | { kind: 'moneyline'; team: string }
  | { kind: 'spread'; team: string; handicap: number } // handicap for `team`, e.g. -2.5 or +2.5
  | { kind: 'total'; line: number; over: boolean }
  | { kind: 'soccer_winner'; team: string | null; yes: boolean } // team null = "draw" market
  | { kind: 'unsupported'; reason: string };

const parseLine = (whole: string, frac: string) => Number(`${whole}.${frac}`);

/**
 * Intl slug formats (verified live):
 *   moneyline:  slug === event_slug                       outcome = team name
 *   spread:     <event>-spread-(home|away)-2pt5            title "Spread: Heat (-2.5)", outcome = team
 *   total:      <event>-total-4pt5                         outcome = Over | Under
 *   soccer:     <event>-<teamcode> | <event>-draw          title "Will X win on DATE?", outcome = Yes | No
 */
/**
 * The whale's activity sometimes comes back with a blank event_slug. Game slugs always start with
 * "<league>-<team>-<team>-YYYY-MM-DD", so rebuild it from the market slug when that happens.
 */
export function withEventSlug<T extends Pick<IntlActivity, 'slug' | 'event_slug'>>(t: T): T {
  // Extra markets (game totals etc.) can sit on a separate "<game>-more-markets" page. Point them at the
  // game itself so they're handled like the same bet on the main page (they used to be skipped unless the
  // event slug happened to come back blank).
  if (t.event_slug?.endsWith('-more-markets')) {
    const game = t.event_slug.slice(0, -'-more-markets'.length);
    if (t.slug.startsWith(`${game}-`)) return { ...t, event_slug: game };
  }
  if (t.event_slug) return t;
  const m = t.slug.match(/^([a-z0-9]+(?:-[a-z0-9]+)+?-\d{4}-\d{2}-\d{2})(?:-|$)/);
  return m ? { ...t, event_slug: m[1]! } : t;
}

export function classifyIntlTrade(t: Pick<IntlActivity, 'slug' | 'event_slug' | 'title' | 'outcome'>): IntlBet {
  if (!t.event_slug || !t.slug.startsWith(t.event_slug)) return { kind: 'unsupported', reason: 'not part of a game event' };
  const suffix = t.slug.slice(t.event_slug.length);
  const outcome = t.outcome.trim();

  if (suffix === '') {
    if (/^(yes|no)$/i.test(outcome)) return { kind: 'unsupported', reason: 'yes/no market without a team' };
    return { kind: 'moneyline', team: outcome };
  }

  const spread = suffix.match(/^-spread-(?:home|away)-(\d+)pt(\d+)$/);
  if (spread) {
    const title = t.title.match(/^Spread:\s*(.+?)\s*\(([+-]?\d+(?:\.\d+)?)\)/i);
    if (!title) return { kind: 'unsupported', reason: `could not read spread title "${t.title}"` };
    const favTeam = title[1]!;
    const favLine = Number(title[2]);
    const size = parseLine(spread[1]!, spread[2]!);
    if (Math.abs(Math.abs(favLine) - size) > 1e-9) return { kind: 'unsupported', reason: 'spread title and slug disagree' };
    const isFav = teamScore(outcome, [favTeam]) > 0;
    return { kind: 'spread', team: outcome, handicap: isFav ? favLine : -favLine };
  }

  const total = suffix.match(/^-total-(\d+)pt(\d+)$/);
  if (total) {
    if (!/^(over|under)$/i.test(outcome)) return { kind: 'unsupported', reason: `total with outcome "${outcome}"` };
    return { kind: 'total', line: parseLine(total[1]!, total[2]!), over: /^over$/i.test(outcome) };
  }

  if (/^(yes|no)$/i.test(outcome)) {
    const yes = /^yes$/i.test(outcome);
    if (/draw/i.test(suffix) || /draw/i.test(t.title)) return { kind: 'soccer_winner', team: null, yes };
    const win = t.title.match(/^Will (.+?) win(?: on .*)?\?$/i);
    if (win && /^-[a-z0-9]+$/.test(suffix)) return { kind: 'soccer_winner', team: win[1]!, yes };
  }

  return { kind: 'unsupported', reason: `market type "${suffix}" isn't copied (only full-game moneyline/spread/total)` };
}

// ---------------------------------------------------------------------------
// 2. Team name matching ("Clippers" vs "Los Angeles Clippers", "Zips" vs "Akron")
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(['fc', 'cf', 'sc', 'ac', 'the', 'of', 'club', 'de', 'afc', 'bv', 'vs']);

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const tokens = (s: string) => normalize(s).split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

/** Same word, or one is an abbreviation of the other ("mich" ~ "michigan", "st" handled as a stopword). */
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

/**
 * 0 = no match, higher = better.
 *   100  identical after normalizing
 *    90  every word matches both ways          "Michigan State" ~ "Mich. State"
 *    60  every word of `name` is in candidate  "Heat" ~ "Miami Heat"
 *    40  candidate is only part of `name`      "Michigan State" vs "Michigan"  (the other team, usually)
 *  10/w  some shared words
 * The 90-vs-40 gap is what stops "Michigan State" being matched to Michigan.
 */
export function teamScore(name: string, candidates: (string | undefined)[]): number {
  const n = normalize(name);
  if (!n) return 0;
  const nt = tokens(name);
  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    const m = normalize(c);
    if (!m) continue;
    if (m === n) return 100;
    const ct = tokens(c);
    if (!nt.length || !ct.length) continue;
    const nameCovered = nt.every((w) => ct.some((v) => sameWord(w, v)));
    const candCovered = ct.every((v) => nt.some((w) => sameWord(w, v)));
    if (nameCovered && candCovered) best = Math.max(best, 90);
    else if (nameCovered) best = Math.max(best, 60);
    else if (candCovered) best = Math.max(best, 40);
    else {
      const overlap = ct.filter((v) => nt.some((w) => sameWord(w, v))).length;
      if (overlap) best = Math.max(best, 10 * overlap);
    }
  }
  return best;
}

const sideNames = (s: UsMarketSide | undefined) =>
  s ? [s.team?.name, s.team?.alias, s.team?.safeName, s.team?.abbreviation] : [];

/** Which side's team is `team`? Requires a clear winner. */
function matchSide(market: UsMarket, team: string): UsSide | null {
  const long = market.marketSides?.find((s) => s.long);
  const short = market.marketSides?.find((s) => !s.long);
  const l = teamScore(team, sideNames(long));
  const s = teamScore(team, sideNames(short));
  if (l > s && l > 0) return 'LONG';
  if (s > l && s > 0) return 'SHORT';
  return null;
}

// ---------------------------------------------------------------------------
// 3. Pick the US market and side
// ---------------------------------------------------------------------------

export interface Resolved {
  market: UsMarket;
  side: UsSide; // side of the US market that matches the whale's outcome
  description: string;
}

const isOpen = (m: UsMarket) => m.active !== false && m.closed !== true;
const type = (m: UsMarket) => m.sportsMarketType ?? '';
const sameLine = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-9;
const hasTeams = (m: UsMarket) => (m.marketSides ?? []).some((s) => s.team?.name);

/** `includeClosed` is only for tools/backfill.ts (replaying past trades); the bot never buys a closed market. */
export function resolveInEvent(bet: IntlBet, ev: UsEvent, includeClosed = false): Resolved | { error: string } {
  const markets = (ev.markets ?? []).filter((m) => includeClosed || isOpen(m));
  if (bet.kind !== 'unsupported' && !markets.length && ev.markets?.length) return { error: `every US market for ${ev.slug} is closed (game over or not trading)` };
  switch (bet.kind) {
    case 'unsupported':
      return { error: bet.reason };

    case 'moneyline': {
      const m = markets.find((x) => /_full_game_winner$/.test(type(x)));
      if (!m) return { error: 'no full-game winner market on US' };
      const side = matchSide(m, bet.team);
      if (!side) return { error: `team "${bet.team}" not found in ${m.slug}` };
      return { market: m, side, description: `${bet.team} to win` };
    }

    case 'spread': {
      // US spread market: `line` is the LONG team's handicap (e.g. long=Ohio, line=-3.5 -> "Ohio -3.5").
      for (const m of markets.filter((x) => /_full_game_spread$/.test(type(x)))) {
        const side = matchSide(m, bet.team);
        if (side === 'LONG' && sameLine(m.line, bet.handicap)) return { market: m, side, description: `${bet.team} ${fmt(bet.handicap)}` };
        if (side === 'SHORT' && sameLine(m.line, -bet.handicap)) return { market: m, side, description: `${bet.team} ${fmt(bet.handicap)}` };
      }
      return { error: `no US spread market for ${bet.team} ${fmt(bet.handicap)}` };
    }

    case 'total': {
      // Game totals have Over/Under sides with no team (team totals have a team attached).
      const m = markets.find((x) => /_full_game_total$/.test(type(x)) && !hasTeams(x) && sameLine(x.line, bet.line));
      if (!m) return { error: `no US game total at ${bet.line}` };
      return { market: m, side: bet.over ? 'LONG' : 'SHORT', description: `${bet.over ? 'Over' : 'Under'} ${bet.line}` };
    }

    case 'soccer_winner': {
      const winners = markets.filter((x) => /_full_time_winner$/.test(type(x)));
      const m =
        bet.team === null
          ? winners.find((x) => /-draw$/.test(x.slug) || !hasTeams(x))
          : winners
              .map((x) => ({ x, score: teamScore(bet.team!, sideNames(x.marketSides?.find((s) => s.long))) }))
              .filter((c) => c.score > 0)
              .sort((a, b) => b.score - a.score)[0]?.x;
      if (!m) return { error: `no US match-winner market for ${bet.team ?? 'draw'}` };
      return { market: m, side: bet.yes ? 'LONG' : 'SHORT', description: `${bet.team ?? 'Draw'}: ${bet.yes ? 'Yes' : 'No'}` };
    }
  }
}

const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`);

// ---------------------------------------------------------------------------
// 4. Find the US event (exact slug first, then search by team names + date)
// ---------------------------------------------------------------------------

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; ev: UsEvent | null }>();

export async function getUsEvent(slug: string): Promise<UsEvent | null> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ev;
  let ev: UsEvent | null = null;
  try {
    ev = (await getJson<{ event: UsEvent }>(`${US_GATEWAY}/v1/events/slug/${encodeURIComponent(slug)}`)).event ?? null;
  } catch (e) {
    if (!(e instanceof HttpError && (e.status === 404 || e.status === 400))) throw e;
  }
  cache.set(slug, { at: Date.now(), ev });
  return ev;
}

const slugDate = (slug: string) => slug.match(/(\d{4}-\d{2}-\d{2})$/)?.[1];
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/** Words worth searching for, taken from the intl title and outcome. */
function searchQueries(t: IntlActivity, bet: IntlBet): string[] {
  const title = t.title
    .replace(/^Spread:\s*/i, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/:\s*O\/U.*$/i, '')
    .replace(/^Will\s+/i, '')
    .replace(/\s+win( on .*)?\?$/i, '')
    .replace(/\bvs\.?\b/gi, ' ')
    .replace(/\s+-\s+.*$/, '');
  const qs = [title];
  if ('team' in bet && bet.team) {
    // Spread titles name only the favorite ("Spread: Pelicans (-5.5)"), so also search both teams together.
    if (teamScore(bet.team, [title]) === 0) qs.push(`${title} ${bet.team}`);
    qs.push(bet.team);
  }
  return [...new Set(qs.map((q) => q.replace(/\s+/g, ' ').trim()).filter((q) => q.length >= 3))];
}

export interface ResolveResult {
  resolved?: Resolved;
  eventSlug?: string;
  how?: 'exact-slug' | 'search';
  error?: string;
}

/** League code of an intl trade: the start of its event slug ("nba-lal-bos-2026-11-08" -> "nba"). */
export const leagueOf = (t: Pick<IntlActivity, "event_slug">): string => (t.event_slug ?? "").split("-")[0]!.toLowerCase();

export async function resolveTrade(t: IntlActivity, kinds: readonly MarketKind[], leagues: readonly string[] = [], includeClosed = false): Promise<ResolveResult> {
  if (leagues.length && !leagues.includes(leagueOf(t))) return { error: `league "${leagueOf(t) || "?"}" is not in LEAGUES (${leagues.join(", ")})` };
  const bet = classifyIntlTrade(t);
  if (bet.kind === 'unsupported') return { error: bet.reason };
  if (!kinds.includes(bet.kind)) return { error: `${bet.kind} markets are turned off in MARKET_KINDS` };

  const exact = await getUsEvent(t.event_slug);
  if (exact) {
    const r = resolveInEvent(bet, exact, includeClosed);
    return 'error' in r ? { error: r.error, eventSlug: exact.slug } : { resolved: r, eventSlug: exact.slug, how: 'exact-slug' };
  }

  // Fallback: team codes sometimes differ (intl "nhl-car-nsh-..." vs US "nhl-car-nas-...").
  const league = t.event_slug.split('-')[0];
  const date = slugDate(t.event_slug);
  if (!league || !date) return { error: `no US event "${t.event_slug}"` };
  const candidates = new Set<string>();
  for (const q of searchQueries(t, bet)) {
    const res = await getJson<{ events?: { slug: string }[] }>(`${US_GATEWAY}/v1/search?query=${encodeURIComponent(q)}&limit=50`).catch(() => ({ events: [] }));
    for (const e of res.events ?? []) {
      const d = slugDate(e.slug);
      if (e.slug.startsWith(`${league}-`) && d && daysApart(d, date) <= 1) candidates.add(e.slug);
    }
  }
  const matches: { ev: UsEvent; r: Resolved }[] = [];
  const misses: string[] = [];
  for (const slug of candidates) {
    const ev = await getUsEvent(slug);
    if (!ev) continue;
    const r = resolveInEvent(bet, ev, includeClosed);
    if ('error' in r) misses.push(`${slug}: ${r.error}`);
    else matches.push({ ev, r });
  }
  if (matches.length > 1) {
    // e.g. "Suns" matches tonight's Blazers-Suns and tomorrow's Magic-Suns: keep the same-day game.
    const sameDay = matches.filter((m) => slugDate(m.ev.slug) === date);
    if (sameDay.length === 1) matches.splice(0, matches.length, sameDay[0]!);
  }
  if (matches.length === 1) return { resolved: matches[0]!.r, eventSlug: matches[0]!.ev.slug, how: 'search' };
  if (matches.length > 1) return { error: `ambiguous: ${matches.map((m) => m.ev.slug).join(', ')}` };
  if (misses.length) return { error: `found ${misses.join('; ')}` };
  return { error: `no matching US event for "${t.event_slug}"` };
}
