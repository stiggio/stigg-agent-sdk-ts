/** `isAccessDenied`, through whatever a framework wraps a denial in. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AccessDeniedError, isAccessDenied } from '../src';

describe('isAccessDenied, through what frameworks wrap a denial in', () => {
  const denial = new AccessDeniedError({
    hasAccess: false,
    deniedBy: 'agent-1',
    source: 'rest',
    checkedAt: 0,
    summary: '',
    message: 'refused',
  });

  it('finds it down a chain of causes, one per middleware', () => {
    const wrapped = new Error('outer', {
      cause: new Error('middle', { cause: new Error('inner', { cause: denial }) }),
    });
    assert.equal(isAccessDenied(wrapped)?.deniedBy, 'agent-1');
  });

  it('finds it inside an AggregateError, as two failed branches of one step arrive', () => {
    assert.equal(isAccessDenied(new AggregateError([new Error('other'), denial]))?.deniedBy, 'agent-1');
  });

  it('stops on a cyclic cause instead of spinning', () => {
    const loop: Error & { cause?: unknown } = new Error('loop');
    loop.cause = loop;
    assert.equal(isAccessDenied(loop), undefined);
  });
});
