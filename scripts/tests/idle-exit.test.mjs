import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdleExit, IDLE_LIMIT_MS } from '../lib/idle-exit.ts';

const HOUR = 60 * 60 * 1000;
const idleSession = { isIdle: () => true, hasPendingMessages: () => false };

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

test('a session closes only after 48 hours without activity', () => {
  const c = clock();
  const idle = createIdleExit({ now: c.now });
  assert.equal(IDLE_LIMIT_MS, 48 * HOUR);
  c.advance(48 * HOUR - 1);
  assert.equal(idle.shouldExit(idleSession), false);
  c.advance(1);
  assert.equal(idle.shouldExit(idleSession), true);
});

test('activity restarts the idle period', () => {
  const c = clock();
  const idle = createIdleExit({ now: c.now });
  c.advance(47 * HOUR);
  idle.touch();
  c.advance(47 * HOUR);
  assert.equal(idle.shouldExit(idleSession), false);
  c.advance(HOUR);
  assert.equal(idle.shouldExit(idleSession), true);
});

test('never closes while the agent is working or a message is queued', () => {
  const c = clock();
  const idle = createIdleExit({ now: c.now });
  c.advance(100 * HOUR);
  assert.equal(idle.shouldExit({ isIdle: () => false, hasPendingMessages: () => false }), false);
  assert.equal(idle.shouldExit({ isIdle: () => true, hasPendingMessages: () => true }), false);
  assert.equal(idle.shouldExit(idleSession), true);
});
