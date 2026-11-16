import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Executor } from '../src/executor.ts';
import type { Config } from '../src/config.ts';

// A fake exchange client: create() returns the given executions, retrieve() the given order.
function fakeExecutor(executions: unknown[], order: Record<string, unknown>) {
  const exec = new Executor({ DRY_RUN: false } as Config);
  (exec as unknown as { client: unknown }).client = {
    orders: {
      create: async () => ({ id: 'X1', executions }),
      retrieve: async () => ({ order }),
    },
  };
  return exec;
}
const req = (side: 'LONG' | 'SHORT') => ({ usSlug: 'tsc-x', side, action: 'BUY' as const, qty: 10, limitPrice: 0.5, tick: 0.01 });

// Real case (2026-11-08): filled orders whose executions still carried the default reject reason.
test('a fill carrying the default EXCHANGE_OPTION reject reason counts as filled', async () => {
  const fill = await fakeExecutor(
    [{ type: 'EXECUTION_TYPE_FILL', lastShares: '9.8', lastPx: { value: '0.50' }, orderRejectReason: 'ORD_REJECT_REASON_EXCHANGE_OPTION' }],
    { state: 'ORDER_STATE_FILLED', cumQuantity: 9.8, avgPx: { value: '0.5000' }, commissionNotionalTotalCollected: { value: '0.1700' } },
  ).place(req('SHORT'));
  assert.equal(fill.filledQty, 9.8);
  assert.equal(fill.avgPrice, 0.5);
  assert.equal(fill.feeUsd, 0.17);
});

test('SHORT fill price is converted from LONG terms', async () => {
  const fill = await fakeExecutor([], { state: 'ORDER_STATE_FILLED', cumQuantity: 10, avgPx: { value: '0.30' } }).place(req('SHORT'));
  assert.ok(Math.abs(fill.avgPrice - 0.7) < 1e-9);
});

test('a real rejection is reported as not filled', async () => {
  const fill = await fakeExecutor(
    [{ type: 'EXECUTION_TYPE_REJECTED', orderRejectReason: 'ORD_REJECT_REASON_EXCHANGE_OPTION', text: 'Insufficient buying power' }],
    { state: 'ORDER_STATE_REJECTED', cumQuantity: 0 },
  ).place(req('LONG'));
  assert.equal(fill.filledQty, 0);
  assert.match(fill.note ?? '', /rejected.*Insufficient buying power/);
});

test('an IOC that matched nothing is not filled', async () => {
  const fill = await fakeExecutor([{ type: 'EXECUTION_TYPE_CANCELED' }], { state: 'ORDER_STATE_CANCELED', cumQuantity: 0 }).place(req('LONG'));
  assert.equal(fill.filledQty, 0);
});

test('a failed send of a real order is reported as uncertain (never retried)', async () => {
  const { OrderUncertainError } = await import('../src/executor.ts');
  const exec = new Executor({ DRY_RUN: false } as Config);
  (exec as unknown as { client: unknown }).client = { orders: { create: async () => { throw new Error('timeout of 15000ms exceeded'); } } };
  await assert.rejects(exec.place(req('LONG')), (e: Error) => e instanceof OrderUncertainError && /timeout/.test(e.message));
});
