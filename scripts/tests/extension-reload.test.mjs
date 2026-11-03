// /reload in one process must pick up a changed helper: Pi's loader imports .mjs natively and Node
// keeps that module, so every helper behind a harness extension is TypeScript. Each case loads the
// real extension with an older helper, swaps in the current one and reloads in the same process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const modules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const { loadExtensions } = await import(pathToFileURL(join(modules, '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);

// The real extension in a fixture with the same layout, importing whichever helper file it names.
async function fixture(name, helperBase, olderHelper, check) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-reload-`));
  try {
    const source = readFileSync(join(root, `pi/extensions/${name}.ts`), 'utf8');
    const helper = source.match(new RegExp(`from ['"](\\.\\./\\.\\./scripts/lib/${helperBase}\\.[a-z]+)['"]`))[1];
    const extension = join(dir, `pi/extensions/${name}.ts`);
    const fixtureHelper = join(dirname(extension), helper);
    mkdirSync(dirname(extension), { recursive: true });
    mkdirSync(dirname(fixtureHelper), { recursive: true });
    writeFileSync(extension, source);
    writeFileSync(fixtureHelper, olderHelper);
    const load = async () => {
      const result = await loadExtensions([extension], dir);
      assert.deepEqual(result.errors, []);
      return result.extensions[0];
    };
    await check(await load(), 'older', dir);
    copyFileSync(join(root, 'scripts/lib', helper.split('/').pop()), fixtureHelper);
    await check(await load(), 'current', dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('diff-pane: reload uses the current helper, so /edit works after the helper gains it', async () => {
  const previous = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  // edit() checks tmux and the path before touching tmux, so no server is needed.
  process.env.TMUX = 'unused,0,0';
  process.env.TMUX_PANE = '%0';
  try {
    await fixture('diff-pane', 'diff-pane', `export function createDiffPane() {
  return { hunk: 'hunk', nvim: 'nvim', available: () => false, newPrompt() {}, async before() {}, async settle() {}, async close() {} };
}
`, async (extension, version, dir) => {
      const notices = [];
      const ctx = { mode: 'tui', cwd: dir, hasUI: true, ui: { notify: text => notices.push(text) } };
      await extension.commands.get('edit').handler('missing.md', ctx);
      assert.match(notices.pop(), version === 'older' ? /pane\.edit is not a function/ : /File not found: .*missing\.md/);
    });
  } finally {
    Object.assign(process.env, previous);
    for (const key of Object.keys(previous)) if (previous[key] === undefined) delete process.env[key];
  }
});

test('code-quality: reload uses the current review helper', async () => {
  await fixture('code-quality', 'quality-review', `export function reviewModel() { return 'older-model'; }
export async function runReview() {
  return { text: 'older review', metrics: { elapsedMs: 0, assistantMessages: 0, usageReports: 0, tokens: null } };
}
`, async (extension, version, dir) => {
    const ctx = { cwd: dir, model: { provider: 'unknown-provider' }, ui: { setStatus() {}, setWidget() {}, notify() {} } };
    const review = extension.tools.get('quality_review').definition.execute('reload', { brief: 'Review fixture' }, undefined, undefined, ctx);
    if (version === 'older') assert.equal((await review).content[0].text, 'older review');
    else await assert.rejects(review, /Choose a reviewer model/);
  });
});

test('quality-feedback: reload uses the current detector', async () => {
  await fixture('quality-feedback', 'quality-feedback', `export function loadPolicy() { return { standingDocuments: ['notes.md'] }; }
export function snapshot(event, cwd) { return { cwd }; }
export function feedback() { return ['older finding']; }
`, async (extension, version, dir) => {
    const ctx = { cwd: dir };
    const event = { toolCallId: `call-${version}`, toolName: 'write', input: { path: join(dir, 'scratch.txt'), content: 'x' } };
    for (const handler of extension.handlers.get('tool_call')) await handler(event, ctx);
    let result;
    for (const handler of extension.handlers.get('tool_result')) result = await handler({ ...event, content: [] }, ctx) ?? result;
    const text = (result?.content ?? []).map(part => part.text).join('\n');
    // The current detector finds nothing in a non-standing scratch file; the older one always reports.
    if (version === 'older') assert.match(text, /older finding/);
    else assert.doesNotMatch(text, /older finding/);
  });
});
