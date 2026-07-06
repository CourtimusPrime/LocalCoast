import { describe, expect, it } from 'vitest';
import { evaluateAssertion, selectPath } from '../src/engines/assertion.js';

const observed = {
  url: 'http://localhost:3000/cart',
  inFlightRequests: [{ url: '/a', method: 'GET' }],
  recentErrors: [],
  recentConsole: [
    { payload: { level: 'warn', text: 'deprecated' } },
    { payload: { level: 'error', text: 'boom' } },
  ],
  cart: { itemCount: 2 },
};

describe('selectPath', () => {
  it('resolves nested paths', () => {
    expect(selectPath(observed, 'cart.itemCount')).toEqual([2]);
  });
  it('resolves array wildcard', () => {
    expect(selectPath(observed, 'recentConsole[*].payload.level')).toEqual(['warn', 'error']);
  });
  it('resolves array index', () => {
    expect(selectPath(observed, 'inFlightRequests[0].method')).toEqual(['GET']);
  });
});

describe('evaluateAssertion', () => {
  it('count', () => {
    expect(evaluateAssertion(observed, { select: 'recentErrors', op: 'count', value: 0 }).pass).toBe(true);
    expect(evaluateAssertion(observed, { select: 'inFlightRequests', op: 'count', value: 1 }).pass).toBe(true);
  });
  it('equals with scalar coercion', () => {
    expect(evaluateAssertion(observed, { select: 'cart.itemCount', op: 'equals', value: 2 }).pass).toBe(true);
    expect(evaluateAssertion(observed, { select: 'cart.itemCount', op: 'equals', value: '2' }).pass).toBe(true);
    expect(evaluateAssertion(observed, { select: 'cart.itemCount', op: 'equals', value: 3 }).pass).toBe(false);
  });
  it('contains over wildcard results', () => {
    expect(
      evaluateAssertion(observed, { select: 'recentConsole[*].payload.level', op: 'contains', value: 'error' }).pass,
    ).toBe(true);
  });
  it('exists / absent', () => {
    expect(evaluateAssertion(observed, { select: 'cart.itemCount', op: 'exists' }).pass).toBe(true);
    expect(evaluateAssertion(observed, { select: 'cart.missing', op: 'absent' }).pass).toBe(true);
  });
  it('numeric comparisons', () => {
    expect(evaluateAssertion(observed, { select: 'cart.itemCount', op: 'gte', value: 2 }).pass).toBe(true);
    expect(evaluateAssertion(observed, { select: 'cart.itemCount', op: 'lt', value: 2 }).pass).toBe(false);
  });
  it('reports actual value', () => {
    const result = evaluateAssertion(observed, { select: 'cart.itemCount', op: 'equals', value: 99 });
    expect(result.pass).toBe(false);
    expect(result.actual).toBe(2);
  });
});
