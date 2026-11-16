import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notify, sendNtfy, setupNotify } from '../src/notify.ts';

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return impl(url, init); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('dry runs and an empty topic send nothing', async () => {
  const m = mockFetch(async () => new Response('ok'));
  try {
    setupNotify({ NTFY_TOPIC: 'abc', NTFY_SERVER: 'https://ntfy.sh', DRY_RUN: true });
    assert.equal(await notify('t', 'm'), false);
    setupNotify({ NTFY_TOPIC: '', NTFY_SERVER: 'https://ntfy.sh', DRY_RUN: false });
    assert.equal(await notify('t', 'm'), false);
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('live bot posts the message to the topic', async () => {
  const m = mockFetch(async () => new Response('ok'));
  try {
    setupNotify({ NTFY_TOPIC: 'my-topic', NTFY_SERVER: 'https://ntfy.sh/', DRY_RUN: false });
    assert.equal(await notify('Bet placed: $4.97', 'Canadiens · Canadiens vs. Bruins', { tags: ['moneybag'] }), true);
    assert.equal(m.calls[0]!.url, 'https://ntfy.sh/my-topic');
    const h = m.calls[0]!.init.headers as Record<string, string>;
    assert.equal(h.Title, 'Bet placed: $4.97');
    assert.equal(h.Tags, 'moneybag');
    assert.equal(m.calls[0]!.init.body, 'Canadiens · Canadiens vs. Bruins');
  } finally { m.restore(); }
});

test('a failed notification never throws', async () => {
  const m = mockFetch(async () => { throw new Error('offline'); });
  try {
    assert.equal(await sendNtfy('https://ntfy.sh', 'x', 'Title ½×', 'body'), false);
  } finally { m.restore(); }
});
