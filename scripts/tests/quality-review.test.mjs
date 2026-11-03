import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview, reviewModel } from '../lib/quality-review.ts';

async function fixture(t, source) {
  const cwd = await mkdtemp(join(tmpdir(), 'quality review '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'child.mjs');
  await writeFile(file, source);
  return { cwd, executable: { command: process.execPath, args: [file] } };
}
const final = text => JSON.stringify({ type: 'message_end', message: {
  role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }],
} });

test('opposite-provider defaults; unknown provider needs an explicit choice', () => {
  assert.equal(reviewModel('openai'), 'claude-bridge/claude-opus-5-5');
  assert.equal(reviewModel('claude-bridge'), 'openai/gpt-6.1-sol');
  assert.throws(() => reviewModel('unknown'));
  assert.equal(reviewModel('unknown', 'chosen/model'), 'chosen/model');
});

test('real child gets isolated arguments and exact brief; only final text returns', async t => {
  const f = await fixture(t, `let input='';
    for await (const chunk of process.stdin) input += chunk;
    const text=JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),input});
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'intermediate'}]}}));
    console.log(JSON.stringify({type:'tool_execution_end',result:'private tool output'}));
    const output=JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'thinking',thinking:'private'},{type:'text',text}]}});
    process.stdout.write(output.slice(0,17));
    setTimeout(()=>process.stdout.write(output.slice(17)),10);`);
  for (const model of ['openai/gpt-6.1-sol', 'claude-bridge/claude-opus-5-5']) {
    const result = await runReview({ cwd:f.cwd, model, bridge:'/bridge with spaces/index.ts',
      brief:'Original request\n$(not a shell command)', instructions:'Review only' }, f.executable);
    const received = JSON.parse(result.text);
    assert.equal(received.cwd, await realpath(f.cwd));
    assert.equal(received.input, 'Original request\n$(not a shell command)');
    for (const flag of ['--no-session','--no-extensions','--no-skills','--no-context-files','--no-mcp','--no-prompt-templates']) assert.ok(received.args.includes(flag));
    assert.equal(received.args.includes('-e'), model.startsWith('claude-bridge/'));
    assert.equal(received.args[received.args.indexOf('--tools')+1], 'read,bash,grep,find,ls');
  }
});

for (const [name, source] of [
  ['nonzero exit after answer', `console.log(${JSON.stringify(final('answer'))}); process.exitCode=1;`],
  ['provider error', `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider failed'}}));`],
  ['malformed event', `console.log('not JSON');`],
  ['empty run', ''],
  ['tool-call text without completion', `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'starting'}]}}));`],
  ['earlier answer followed by incomplete continuation', `console.log(${JSON.stringify(final('earlier'))}); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'length',content:[]}}));`],
]) test(`${name} cannot claim a completed review`, async t => {
  const f = await fixture(t, source);
  await assert.rejects(runReview({cwd:f.cwd,model:'openai/test',brief:'request',instructions:'review'},f.executable));
});

test('a recovered provider retry returns the completed review', async t => {
  const f = await fixture(t, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'529 overloaded'}}));
    console.log(JSON.stringify({type:'auto_retry_start',attempt:1}));
    console.log(${JSON.stringify(final('Recovered findings'))});`);
  const result = await runReview({cwd:f.cwd,model:'openai/test',brief:'request',instructions:'review'},f.executable);
  assert.equal(result.text,'Recovered findings');
});

test('abort terminates an active child and reports cancellation', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const controller = new AbortController();
  const promise = runReview({cwd:f.cwd,model:'openai/test',brief:'request',instructions:'review',signal:controller.signal},f.executable);
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(promise, /cancelled/);
});

test('cancellation also terminates a descendant ignoring SIGTERM', { skip: process.platform === 'win32', timeout: 5000 }, async t => {
  const f = await fixture(t, `import {spawn} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
    child.stdout.once('data',()=>writeFileSync('pid',String(child.pid)));
    setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const promise = runReview({cwd:f.cwd,model:'openai/test',brief:'request',instructions:'review',signal:controller.signal},f.executable);
  const rejected = assert.rejects(promise, /cancelled/);
  let pid;
  t.after(() => { if(pid) { try { process.kill(pid,'SIGKILL'); } catch {} } });
  for(let i=0;i<100;i++) {
    try { pid=Number(await readFile(join(f.cwd,'pid'),'utf8')); break; } catch {}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(pid, 'descendant started');
  controller.abort();
  await rejected;
  for(let i=0;i<100;i++) {
    try { process.kill(pid,0); } catch(error) { assert.equal(error.code,'ESRCH'); return; }
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('descendant survived cancellation');
});

test('counts completed assistant usage once, including tool turns and cache, without adding reasoning twice', async t => {
  const events = [
    {type:'message_update',message:{role:'assistant',usage:{input:999,output:999,cacheRead:999,cacheWrite:999}}},
    {type:'message_end',message:{role:'assistant',stopReason:'toolUse',content:[],usage:{input:10,output:2,cacheRead:20,cacheWrite:3,reasoning:1,totalTokens:35}}},
    {type:'message_end',message:{role:'toolResult',usage:{input:999,output:999,cacheRead:999,cacheWrite:999}}},
    {type:'message_end',message:{role:'assistant',stopReason:'toolUse',content:[]}},
    {type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Findings'}],usage:{input:4,output:5,cacheRead:6,cacheWrite:7,totalTokens:22}}},
  ];
  const f = await fixture(t, `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`);
  const updates=[];
  const result=await runReview({cwd:f.cwd,model:'openai/test',brief:'request',instructions:'review',onProgress:m=>updates.push(m)},f.executable);
  assert.deepEqual(result.metrics.tokens,{input:14,output:7,cacheRead:26,cacheWrite:10,total:57});
  assert.equal(result.metrics.assistantMessages,3);
  assert.equal(result.metrics.usageReports,2);
  assert.ok(result.metrics.elapsedMs >= 0);
  assert.equal(updates[0].tokens.total,35, 'progress is a snapshot');
});

test('unreported usage stays unavailable, not zero', async t => {
  const f=await fixture(t, `console.log(${JSON.stringify(final('Done'))});`);
  const result=await runReview({cwd:f.cwd,model:'openai/test',brief:'request',instructions:'review'},f.executable);
  assert.equal(result.metrics.tokens,null);
  assert.equal(result.metrics.usageReports,0);
});

test('failed runs still deliver measured usage and elapsed time', async t => {
  const f=await fixture(t, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'failed',usage:{input:10,output:1,cacheRead:0,cacheWrite:0}}}));`);
  let last;
  await assert.rejects(runReview({cwd:f.cwd,model:'openai/test',brief:'request',instructions:'review',onProgress:m=>last=m},f.executable),/failed/);
  assert.equal(last.tokens.total,11);
  assert.equal(last.assistantMessages,1);
  assert.ok(last.elapsedMs >= 0);
});

test('provider zero-initialised counters are unavailable, not measured zero', async t => {
  const f=await fixture(t, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'stream reset',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0}}}));`);
  let last;
  await assert.rejects(runReview({cwd:f.cwd,model:'openai/test',brief:'request',instructions:'review',onProgress:m=>last=m},f.executable),/stream reset/);
  assert.equal(last.tokens,null);
  assert.equal(last.usageReports,0);
  assert.equal(last.assistantMessages,1);
});
