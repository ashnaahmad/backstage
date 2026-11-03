import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('no-implementation evidence survives tool results and UI, and later progress replaces it', async () => {
  const modules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const { loadExtensions } = await import(pathToFileURL(modules + '/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js'));
  const loaded = await loadExtensions([process.cwd() + '/pi/extensions/code-quality.ts'], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions[0].tools.get('quality_status').definition;
  const displayed = new Map();
  const widgets = new Map();
  const ctx = { ui: { setStatus: (key, value) => displayed.set(key, value),
    setWidget: (key, value) => widgets.set(key, value) } };
  await loaded.extensions[0].handlers.get('session_start')[0]({}, ctx);
  assert.equal(widgets.get('quality'), undefined);
  const declaration = {
    reason: 'Required deployment environment unavailable',
    evidence: 'Authorised endpoint returned access denied',
    alternatives: 'Local probe completed; environment-specific failure remains unverified',
    nextStep: 'Owner provides access to reproduce the environment-specific failure',
  };
  const result = await tool.execute('one', { summary: 'Unresolved', noImplementation: declaration }, undefined, undefined, ctx);
  assert.deepEqual(result.details.noImplementation, declaration);
  assert.ok(widgets.get('quality').join('\n').includes(declaration.evidence));
  for (const value of Object.values(declaration)) assert.ok(widgets.get('quality').join('\n').includes(value));
  assert.equal(displayed.get('quality'), undefined);
  assert.equal(displayed.get('quality-reviews'), undefined);
  const resumed = await tool.execute('two', { summary: 'Access restored; reproducing' }, undefined, undefined, ctx);
  assert.equal(resumed.details.noImplementation, undefined);
  assert.equal(displayed.get('quality'), undefined);
  assert.deepEqual(widgets.get('quality'), ['Quality: Access restored; reproducing']);
  await loaded.extensions[0].commands.get('quality').handler('clear', ctx);
  assert.equal(widgets.get('quality'), undefined);
  await tool.execute('three', {summary:'Checking next change'}, undefined, undefined, ctx);
  assert.deepEqual(widgets.get('quality'), ['Quality: Checking next change']);
  await loaded.extensions[0].handlers.get('session_start')[0]({}, ctx);
  assert.equal(widgets.get('quality'), undefined);
});

// Review display through the real transport and a deterministic fake `pi` on PATH: no model calls.
test('reviews show in the widget and /quality with usage; failures stay visible; a new session resets them', async () => {
  const modules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const { loadExtensions } = await import(pathToFileURL(modules + '/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js'));
  const loaded = await loadExtensions([process.cwd() + '/pi/extensions/code-quality.ts'], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()], ['quality_status', 'quality_review']);
  const widgets = new Map();
  let notice;
  const ctx = { cwd: process.cwd(), model: { provider: 'openai' }, ui: {
    setStatus() {}, setWidget: (key, value) => widgets.set(key, value), notify: text => { notice = text; } } };
  const reviewLine = () => (widgets.get('quality') ?? []).find(line => line.startsWith('Reviews:')) ?? '';
  const quality = extension.commands.get('quality');
  const reviewer = extension.tools.get('quality_review').definition;
  const fake = mkdtempSync(join(tmpdir(), 'quality-ui-'));
  const previousPath = process.env.PATH;
  const fakePi = body => writeFileSync(join(fake, 'pi'), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  const message = (stopReason, text, usage) => `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'${stopReason}',content:${text ? `[{type:'text',text:'${text}'}]` : '[]'}${usage ? `,usage:${usage}` : ''}}}));`;
  try {
    process.env.PATH = `${fake}:${previousPath}`;
    await assert.rejects(reviewer.execute('bad', { brief: 'Review fixture' }, undefined, undefined, { ...ctx, model: { provider: 'unknown' } }), /Choose a reviewer model/);
    for (const handler of extension.handlers.get('session_start')) await handler({}, ctx);

    fakePi(`process.stdin.resume();\n${message('toolUse', '', '{input:12,output:3,cacheRead:4,cacheWrite:1}')}\nsetTimeout(()=>{${message('stop', 'No findings', '{input:2,output:5,cacheRead:6,cacheWrite:0}')}},1300);`);
    const pending = reviewer.execute('usage', { brief: 'Review fixture' }, undefined, undefined, ctx);
    for (let i = 0; i < 40 && !/0m [1-9]s/.test(reviewLine()); i++) await new Promise(done => setTimeout(done, 100));
    assert.match(reviewLine(), /^Reviews: 1 · 0m [1-9]s · 3 out/, 'the running review shows its elapsed time and usage so far');
    const reply = await pending;
    assert.equal(reply.details.metrics.tokens.total, 33);
    assert.match(reviewLine(), /8 out/);
    await quality.handler('', ctx);
    assert.match(notice, /returned; .*14 input, 8 output, 10 cache-read, 1 cache-write/);

    fakePi('process.exitCode=1;');
    await assert.rejects(reviewer.execute('failure', { brief: 'Review fixture' }, undefined, undefined, ctx));
    await quality.handler('', ctx);
    assert.match(notice, /failed; .*tokens unavailable/, 'a failed review stays visible');

    fakePi(`process.stdin.resume();\n${message('toolUse', '', '{input:1,output:2,cacheRead:0,cacheWrite:0}')}\nsetTimeout(()=>{},60000);`);
    const controller = new AbortController();
    const cancelled = reviewer.execute('cancelled', { brief: 'Review fixture' }, controller.signal, undefined, ctx);
    const rejection = assert.rejects(cancelled, /cancelled/);
    for (let i = 0; i < 40 && !/2 out/.test(reviewLine()); i++) await new Promise(done => setTimeout(done, 25));
    controller.abort();
    await rejection;
    await quality.handler('', ctx);
    assert.match(notice, /cancelled; .*1 input, 2 output/, 'a cancelled review keeps its partial usage');

    for (const handler of extension.handlers.get('session_start')) await handler({}, ctx);
    assert.equal(widgets.get('quality'), undefined);
    await quality.handler('', ctx);
    assert.doesNotMatch(notice, /Review usage/, 'a new session starts without earlier reviews');
  } finally {
    process.env.PATH = previousPath;
    rmSync(fake, { recursive: true, force: true });
  }
});
