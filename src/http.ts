export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
  }
}

/** GET a JSON URL with a timeout. Retries network errors / 429 / 5xx a couple of times. */
export async function getJson<T>(url: string, { timeoutMs = 10_000, retries = 2 } = {}): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'polymarket-copy-bot/0.1' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return (await res.json()) as T;
      const body = await res.text();
      const err = new HttpError(res.status, url, body);
      if (res.status !== 429 && res.status < 500) throw err; // 4xx: retrying won't help
      lastErr = err;
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr;
}
