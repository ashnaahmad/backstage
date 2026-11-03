import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { addedFindings, snapshot, feedback, toolPath, loadPolicy } from '../lib/quality-feedback.ts';

const policy = { standingDocuments: ['PLAN.md', 'guidance/', 'linked.md'] };
test('standing-doc feedback distinguishes history from current prose and examples', () => {
  const rows = '# Current plan\n\n## Recent changes\nUpdated 2026-10-25\n';
  assert.equal(addedFindings('/repo/PLAN.md', '', rows, '/repo', policy).length, 2);
  assert.deepEqual(addedFindings('/repo/research/trial.md', '', rows, '/repo', policy), []);
  assert.deepEqual(addedFindings('/repo/guidance/2026-10-25-report.md', '', rows, '/repo', policy), []);
  assert.deepEqual(addedFindings('/repo/PLAN.md', '', '```md\n'+rows+'```\n> ## Recent changes\nStart on 2026-12-01.', '/repo', policy), []);
  assert.deepEqual(addedFindings('/repo/PLAN.md', rows, 'A new introduction\n'+rows, '/repo', policy), []);
});
test('dated headings and narrative tense in standing prose are flagged; current-state prose is not', () => {
  const dated = '# Note\n\n## Small review transport — 25 October\n\n## Proportional follow-ups\n\n### Rebuild (2026-10-25)\n';
  const kinds = rows => rows.map(r => r.split(': ')[1]);
  assert.deepEqual(kinds(addedFindings('/repo/PLAN.md', '', dated, '/repo', policy)), ['chronology', 'chronology']);
  assert.deepEqual(addedFindings('/repo/research/trial.md', '', dated, '/repo', policy), []);
  assert.deepEqual(addedFindings('/repo/guidance/2026-10-25-report.md', '', dated, '/repo', policy), []);
  const narrative = 'The feedback extension now supplies advisory checks.\nThe runner was subsequently removed.\nThe latest rerun selected review.\n';
  assert.deepEqual(kinds(addedFindings('/repo/PLAN.md', '', narrative, '/repo', policy)), ['tense', 'tense', 'tense']);
  const current = 'Restart Pi now to load the extension.\nThe extension supplies advisory checks.\nIt returns the latest assistant result.\nObeying the latest edit loses the brief.\n## May the plan hold\n> It was previously different.\n```\nnow is fine here\n```\n';
  assert.deepEqual(addedFindings('/repo/PLAN.md', '', current, '/repo', policy), []);
  assert.deepEqual(addedFindings('/repo/PLAN.md', narrative, narrative + 'A new current sentence.\n', '/repo', policy), []);
});
test('absent document scope uses defaults; an explicit list replaces or disables them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-policy-'));
  const config = text => { mkdirSync(join(dir,'.pi'),{recursive:true}); writeFileSync(join(dir,'.pi/quality-checks.json'), text); };
  const standing = path => addedFindings(join(dir,path), '', '## Changelog\n', dir, loadPolicy(dir)).length > 0;
  try {
    assert.deepEqual(['AGENTS.md','README.md','PLAN.md','docs/README.md','notes.md'].map(standing), [true,true,true,false,false]);
    config('{}');
    assert.equal(standing('README.md'), true);
    config(JSON.stringify({standingDocuments:['PLAN.md','notes.md']}));
    assert.deepEqual(['PLAN.md','notes.md','README.md'].map(standing), [true,true,false]);
    config(JSON.stringify({standingDocuments:[]}));
    assert.equal(standing('PLAN.md'), false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('real Pi handlers give default feedback in a repository without configuration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-default-'));
  const git = (...args) => execFileSync('git', args, {cwd:dir, stdio:'pipe', env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.test',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.test'}});
  try {
    git('init');
    writeFileSync(join(dir,'AGENTS.md'),'# Agents\n');
    git('add','.'); git('commit','-m','baseline');
    const modules = execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim();
    const {loadExtensions} = await import(pathToFileURL(join(modules,'@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')));
    const extension = (await loadExtensions([join(process.cwd(),'pi/extensions/quality-feedback.ts')],dir)).extensions[0];
    const call=extension.handlers.get('tool_call')[0];
    const result=extension.handlers.get('tool_result')[0];
    const ctx={cwd:dir};
    const event={toolCallId:'default',toolName:'edit',input:{path:'AGENTS.md'}};
    await call(event,ctx);
    writeFileSync(join(dir,'AGENTS.md'),'# Agents\n## Recent changes\n');
    const reply=await result({...event,content:[{type:'text',text:'Edited'}],isError:false,structuredContent:{ok:true}},ctx);
    assert.match(reply.content[1].text,/AGENTS.md:2: chronology/);
    assert.equal(reply.content[0].text,'Edited');
    assert.equal(reply.isError,undefined);
    assert.deepEqual(reply.structuredContent,{ok:true});
    const shell={toolCallId:'default-shell',toolName:'bash',input:{command:'write'}};
    await call(shell,ctx);
    execFileSync('sh',['-c',"printf '# Readme\\n## Changelog\\n' > README.md"],{cwd:dir});
    assert.match((await result({...shell,content:[]},ctx)).content[0].text,/README.md:2: chronology/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('code markers do not produce feedback', () => {
  assert.deepEqual(addedFindings('/repo/main.py', '', '# TODO example\nraise NotImplementedError', '/repo', policy), []);
  assert.equal(snapshot({toolName:'write', input:{path:'main.py'}}, process.cwd()), undefined);
});
test('real Pi handlers deliver feedback for edits, shell writes and explicit symlinks without changing tool success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-feedback-'));
  const outside = mkdtempSync(join(tmpdir(), 'quality-target-'));
  const git = (...args) => execFileSync('git', args, {cwd:dir, stdio:'pipe', env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.test',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.test'}});
  try {
    git('init');
    mkdirSync(join(dir,'.pi'));
    writeFileSync(join(dir,'.pi/quality-checks.json'), JSON.stringify(policy));
    writeFileSync(join(dir,'PLAN.md'),'# Plan\n');
    git('add','.'); git('commit','-m','baseline');
    const modules = execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim();
    const {loadExtensions} = await import(pathToFileURL(join(modules,'@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')));
    const loaded = await loadExtensions([join(process.cwd(),'pi/extensions/quality-feedback.ts')],dir);
    assert.deepEqual(loaded.errors,[]);
    const extension=loaded.extensions[0];
    const call=extension.handlers.get('tool_call')[0];
    const result=extension.handlers.get('tool_result')[0];
    const ctx={cwd:dir};
    const event={toolCallId:'one',toolName:'edit',input:{path:'PLAN.md'}};
    await call(event,ctx);
    writeFileSync(join(dir,'PLAN.md'),'# Plan\n## Recent changes\nAdded a pane.');
    const reply=await result({...event,content:[{type:'text',text:'Edited'}],isError:false,structuredContent:{ok:true}},ctx);
    assert.match(reply.content[1].text,/PLAN.md:2: chronology/);
    assert.equal(reply.isError,undefined);
    assert.deepEqual(reply.structuredContent,{ok:true});
    assert.equal(reply.content[0].text,'Edited');
    await call(event,ctx);
    writeFileSync(join(dir,'PLAN.md'),'# Plan\nA current description.');
    assert.equal(await result({...event,content:[]},ctx),undefined);
    // Existing local dirt does not become a new warning after a read-only shell call.
    mkdirSync(join(dir,'guidance'));
    writeFileSync(join(dir,'guidance/old.md'),'## Changelog\npre-existing');
    const shell={toolCallId:'shell',toolName:'bash',input:{command:'read or edit'}};
    // An explicitly empty document list disables feedback under global loading.
    writeFileSync(join(dir,'.pi/quality-checks.json'), JSON.stringify({standingDocuments:[]}));
    await call(shell,ctx);
    git('add','.'); git('commit','-m','no document policy');
    assert.equal(await result({...shell,content:[]},ctx),undefined);
    writeFileSync(join(dir,'.pi/quality-checks.json'), JSON.stringify(policy));
    await call(shell,ctx);
    assert.equal(await result({...shell,content:[]},ctx),undefined);
    await call(shell,ctx);
    execFileSync('sh',['-c',"printf '# Plan\\n## Revision history\\n' > PLAN.md"],{cwd:dir});
    const shellReply=await result({...shell,content:[]},ctx);
    assert.match(shellReply.content[0].text,/chronology/);
    assert.doesNotMatch(shellReply.content[0].text,/pre-existing/);
    // Parallel calls share a before-state; report each observed finding once per turn.
    const editBatch={toolCallId:'edit-batch',toolName:'edit',input:{path:'PLAN.md'}};
    const bashBatch={...shell,toolCallId:'bash-batch'};
    await call(editBatch,ctx); await call(bashBatch,ctx);
    writeFileSync(join(dir,'PLAN.md'),'# Plan\n## What changed\n');
    assert.match((await result({...editBatch,content:[]},ctx)).content[0].text,/chronology/);
    assert.equal(await result({...bashBatch,content:[]},ctx),undefined);
    // Absolute aliases and @ paths must use the same document policy.
    const absolute={...event,toolCallId:'absolute',input:{path:join(dir,'PLAN.md')}};
    await call(absolute,ctx);
    writeFileSync(join(dir,'PLAN.md'),'# Plan\n## Changelog\n');
    assert.match((await result({...absolute,content:[]},ctx)).content[0].text,/chronology/);
    assert.equal(toolPath('@PLAN.md',dir),toolPath(join(dir,'PLAN.md'),dir));
    assert.equal(toolPath('~/example.ts',dir),join(homedir(),'example.ts'));
    // Renames and large unchanged prefixes must not rediscover old debt.
    writeFileSync(join(dir,'guidance/large.md'),'## Changelog\n'+'x'.repeat(1500000));
    git('add','.');git('commit','-m','fixtures');
    let baseline=snapshot(shell,dir);
    git('mv','guidance/large.md','guidance/moved.md');
    assert.deepEqual(feedback(baseline,policy),[]);
    git('commit','-m','rename fixture');
    baseline=snapshot(shell,dir);
    execFileSync('sh',['-c',"printf '\nnew line' >> guidance/moved.md"],{cwd:dir});
    assert.deepEqual(feedback(baseline,policy),[]);
    // A history-changing shell command reports the scan boundary, not findings attributed to the agent.
    const before=snapshot(shell,dir);
    writeFileSync(join(dir,'new.ts'),'// TODO implement');
    git('add','.');git('commit','-m','shell edit');
    assert.throws(()=>feedback(before,policy), /HEAD changed/);
    writeFileSync(join(outside,'linked.md'),'# Current note');
    symlinkSync(join(outside,'linked.md'),join(dir,'linked.md'));
    const link={toolCallId:'link',toolName:'write',input:{path:'linked.md'}};
    await call(link,ctx);
    writeFileSync(join(dir,'linked.md'),'## Recent changes');
    assert.match((await result({...link,content:[]},ctx)).content[0].text,/chronology/);
    // A malformed config is reported, never converted into a blocked edit.
    await call(event,ctx);
    writeFileSync(join(dir,'.pi/quality-checks.json'),'{broken');
    assert.match((await result({...event,content:[]},ctx)).content[0].text,/unavailable/);
  } finally { rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true}); }
});
