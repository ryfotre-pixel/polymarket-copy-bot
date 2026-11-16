/**
 * Phone notifications through ntfy (https://ntfy.sh): install the ntfy app, subscribe to the topic in
 * NTFY_TOPIC, and the LIVE bot pushes a message for each bet, result, and problem.
 *
 * Anyone who knows the topic name can read its messages, so use a long random name and keep it private.
 * Messages carry bet details only, never API keys. Sending never throws or slows the bot down for long:
 * a failed notification is just skipped.
 */
export interface NotifyCfg {
  NTFY_TOPIC: string;
  NTFY_SERVER: string;
  DRY_RUN: boolean;
}

export type Priority = 'min' | 'low' | 'default' | 'high' | 'urgent';

let cfg: NotifyCfg | undefined;
let warned = false;

/** Turn notifications on for this process. Only the live bot sends (dry runs stay quiet). */
export function setupNotify(c: NotifyCfg): void {
  cfg = c;
}

export const notifyEnabled = () => !!cfg && !!cfg.NTFY_TOPIC && !cfg.DRY_RUN;

export async function notify(title: string, message: string, opts: { priority?: Priority; tags?: string[] } = {}): Promise<boolean> {
  if (!notifyEnabled()) return false;
  return sendNtfy(cfg!.NTFY_SERVER, cfg!.NTFY_TOPIC, title, message, opts);
}

/** Low-level send, also used by the dashboard's "live bot stopped" watchdog and the test script. */
export async function sendNtfy(server: string, topic: string, title: string, message: string, opts: { priority?: Priority; tags?: string[] } = {}): Promise<boolean> {
  try {
    const res = await fetch(`${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      body: message,
      headers: {
        // Header values must be plain ASCII; titles stay simple, the body can hold anything.
        Title: title.replace(/[^\x20-\x7e]/g, '-'),
        Priority: opts.priority ?? 'default',
        ...(opts.tags?.length ? { Tags: opts.tags.join(',') } : {}),
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn(`[notify] could not send a phone notification (${(e as Error).message}); the bot keeps running`);
    }
    return false;
  }
}
