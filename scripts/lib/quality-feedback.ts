import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';

const supported = path => /\.mdx?$/.test(path);
const read = path => { try { return readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });

// Applies when the workspace configuration omits standingDocuments; an explicit list replaces it.
export const defaultStandingDocuments = ['AGENTS.md', 'README.md', 'PLAN.md'];

export function loadPolicy(cwd) {
  const text = read(resolve(cwd, '.pi/quality-checks.json'));
  const policy = text ? JSON.parse(text) : {};
  if (policy.standingDocuments === undefined) return { ...policy, standingDocuments: defaultStandingDocuments };
  if (!Array.isArray(policy.standingDocuments) || policy.standingDocuments.some(p => typeof p !== 'string' || !p)) {
    throw new Error('standingDocuments must be an array of file paths or directory paths ending in /');
  }
  return policy;
}

// A heading that carries a calendar date or month name in a standing document usually introduces a dated update.
const months = '(?:jan(?:uary|uari)?|feb(?:ruary|ruari)?|mar(?:ch|s)?|apr(?:il)?|ma[yj]|jun[ei]?|jul[yi]?|aug(?:ust|usti)?|sep(?:tember)?|o[ck]t(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const datedHeading = new RegExp(`^#{1,6} .*(?:\\b20\\d\\d-\\d\\d-\\d\\d\\b|\\b\\d{1,2} ${months}\\b|\\b${months} \\d{1,2}\\b)`, 'i');
// Narrative time markers that often describe what changed rather than what is true now.
const tenseMarker = /\b(?:subsequently|previously|no longer|ha(?:s|ve) since|the latest (?:re)?run|the latest (?:trial|version|change|commit|rebuild)|w(?:as|ere) later|now (?:supplies|records|provides|includes|uses|exposes|shows|defaults?|retains?|replaces?|carries|makes|is|are|has|have))\b/i;

function findings(path, text, cwd, policy) {
  const rows = [];
  const rel = relative(cwd, path).split('\\').join('/');
  const standing = (policy.standingDocuments || []).some(p => p.endsWith('/') ? rel.startsWith(p) : rel === p);
  const dated = /20\d\d-\d\d-\d\d/.test(basename(path));
  let fence;
  for (const [i, line] of text.split('\n').entries()) {
    if (/\.mdx?$/.test(path)) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
        continue;
      }
      if (!standing || dated || fence || /^\s*>/.test(line)) continue;
      if (/^\s*[*_]{0,2}(?:Built|Last updated|Updated|Amended|Revised|As of|Version)\b.{0,40}20\d\d-\d\d-\d\d/i.test(line)
        || /^#{1,6} .*\b(?:changelog|revision history|version history|what changed|what's new|recent changes|superseded|migration notes|predates?)\b/i.test(line)
        || /^#{1,6} .*#\d{3,4}\b/.test(line)
        || datedHeading.test(line)) {
        rows.push({ line: i + 1, kind: 'chronology', text: line.trim() });
      } else if (!/^#{1,6} /.test(line) && tenseMarker.test(line)) {
        // Weaker signal: narrative time in standing prose. The agent judges whether it is history.
        rows.push({ line: i + 1, kind: 'tense', text: line.trim() });
      }
    }
  }
  return rows;
}

export function addedFindings(path, before, after, cwd, policy) {
  const counts = new Map();
  const key = row => `${row.kind}:${row.text}`;
  for (const row of findings(path, before, cwd, policy)) counts.set(key(row), (counts.get(key(row)) || 0) + 1);
  return findings(path, after, cwd, policy).filter(row => {
    const n = counts.get(key(row)) || 0;
    if (n) { counts.set(key(row), n - 1); return false; }
    return true;
  }).map(row => `${path}:${row.line}: ${row.kind}: ${row.text}`);
}

function changedPaths(root) {
  return [...new Set([
    ...git(root, ['diff', '--name-only', '-z', 'HEAD', '--']).split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ])].filter(p => p && supported(p));
}

export function toolPath(input, cwd) {
  let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '');
  if (path === '~' || path.startsWith('~/')) path = resolve(homedir(), path.slice(2));
  path = resolve(cwd, path);
  try { return resolve(realpathSync(dirname(path)), basename(path)); } catch { return path; }
}

export function snapshot(event, cwd) {
  cwd = realpathSync(cwd);
  if (['write', 'edit'].includes(event.toolName) && typeof event.input.path === 'string') {
    const path = toolPath(event.input.path, cwd);
    return supported(path) ? { cwd, files: new Map([[path, read(path)]]) } : undefined;
  }
  if (event.toolName !== 'bash') return;
  let root;
  try { root = git(cwd, ['rev-parse', '--show-toplevel']).trim(); } catch { return; }
  // Preserve the base revision even if the command stages or commits its edits.
  let head;
  try { head = git(root, ['rev-parse', 'HEAD']).trim(); } catch { return; }
  return { cwd, root, head, files: new Map(changedPaths(root).map(p => [resolve(root, p), read(resolve(root, p))])) };
}

export function feedback(before, policy) {
  if (!before) return [];
  let paths = [...before.files.keys()];
  const origins = new Map();
  if (before.root) {
    if (git(before.root, ['rev-parse', 'HEAD']).trim() !== before.head) {
      throw new Error('Git HEAD changed during the shell call; inspect its diff separately.');
    }
    const names = git(before.root, ['diff', '--name-status', '-z', '-M', before.head, '--']).split('\0');
    for (let i = 0; i < names.length && names[i];) {
      const status = names[i++], original = names[i++];
      const current = status.startsWith('R') ? names[i++] : original;
      origins.set(resolve(before.root, current), status === 'A' ? null : original);
    }
    const changed = git(before.root, ['diff', '--name-only', '-z', before.head, '--']).split('\0');
    const untracked = git(before.root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
    paths = [...new Set([...paths, ...[...changed, ...untracked].filter(p => p && supported(p)).map(p => resolve(before.root, p))])];
  }
  return paths.flatMap(path => {
    let old = before.files.get(path);
    if (old === undefined) {
      const original = origins.get(path);
      if (original) old = before.files.get(resolve(before.root, original))
        ?? git(before.root, ['show', `${before.head}:${original}`]);
      else {
        // Preserve an unchanged untracked file's baseline when it was moved.
        const now = read(path);
        old = [...before.files.entries()].find(([p, text]) => text === now && read(p) === '')?.[1] ?? '';
      }
    }
    return addedFindings(path, old, read(path), before.cwd, policy);
  });
}
