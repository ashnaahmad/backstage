#!/usr/bin/env python3
"""Free disk by deleting dependency directories from finished Git worktrees.

A worktree qualifies when all of these hold:
- its HEAD is an ancestor of the remote main branch, or its branch's PR has merged
  (checked with one `gh pr list --state merged` call);
- `git status` shows no changes to tracked files and no untracked files outside the
  dependency directories;
- no running process has its working directory inside it;
- nothing in it (outside the dependency directories) changed in the last --idle-hours.

Only directories named node_modules are deleted (at the worktree root and up to two
levels below, e.g. app/node_modules, packages/x/node_modules). Sources, branches,
commits and the worktree registration are untouched, so `npm ci` restores them.

Usage: prune-worktree-deps.py --repo <main checkout> [--root <worktrees dir>]...
       [--remote-main origin/main] [--idle-hours 24] [--apply]
Without --apply it only reports what it would delete (with sizes). With --apply each
dependency directory is first renamed aside (instant), then all are removed concurrently.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DEP_DIR = "node_modules"


def run(args, cwd=None, check=True):
    return subprocess.run(args, cwd=cwd, check=check, capture_output=True, text=True).stdout


def worktrees(repo):
    out = run(["git", "worktree", "list", "--porcelain"], cwd=repo)
    items, cur = [], {}
    for line in out.splitlines() + [""]:
        if not line:
            if cur:
                items.append(cur)
            cur = {}
        elif line.startswith("worktree "):
            cur["path"] = Path(line[9:])
        elif line.startswith("HEAD "):
            cur["head"] = line[5:]
        elif line.startswith("branch "):
            cur["branch"] = line[7:].removeprefix("refs/heads/")
    return items


def merged_heads(repo):
    try:
        out = run(["gh", "pr", "list", "--state", "merged", "--limit", "1000",
                   "--json", "headRefName,headRefOid"], cwd=repo)
    except (subprocess.CalledProcessError, FileNotFoundError) as error:
        print(f"warning: could not list merged PRs ({error}); using ancestry only", file=sys.stderr)
        return set(), set()
    rows = json.loads(out)
    return {r["headRefName"] for r in rows}, {r["headRefOid"] for r in rows}


def process_cwds():
    try:
        out = run(["lsof", "-a", "-d", "cwd", "-Fn"], check=False)
    except FileNotFoundError:
        return []
    return [Path(line[1:]) for line in out.splitlines() if line.startswith("n/")]


def dep_dirs(path):
    found = []
    for depth_glob in ("", "*/", "*/*/"):
        found += [p for p in path.glob(f"{depth_glob}{DEP_DIR}")
                  if p.is_dir() and not p.is_symlink() and DEP_DIR not in p.relative_to(path).parts[:-1]]
    return found


def recently_changed(path, hours):
    cutoff = time.time() - hours * 3600
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = [d for d in dirnames if d not in (DEP_DIR, ".git")]
        for name in filenames:
            try:
                if os.lstat(os.path.join(dirpath, name)).st_mtime > cutoff:
                    return True
            except OSError:
                pass
    return False


def size_bytes(path):
    out = run(["du", "-sk", str(path)], check=False)
    return int(out.split()[0]) * 1024 if out else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, type=Path)
    ap.add_argument("--root", action="append", type=Path, default=[],
                    help="only consider worktrees under these directories (default: all but the main checkout)")
    ap.add_argument("--remote-main", default="origin/main")
    ap.add_argument("--idle-hours", type=float, default=24)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    repo = args.repo.resolve()
    run(["git", "fetch", "--quiet", "origin"], cwd=repo, check=False)
    merged_names, merged_oids = merged_heads(repo)
    cwds = process_cwds()
    roots = [r.resolve() for r in args.root]
    candidates = [wt for wt in worktrees(repo)
                  if wt["path"].resolve() != repo and wt["path"].exists()
                  and (not roots or any(wt["path"].resolve().is_relative_to(r) for r in roots))]

    def assess(wt):
        path = wt["path"]
        deps = dep_dirs(path)
        if not deps:
            return None
        name = wt.get("branch") or f"detached {wt.get('head', '')[:9]}"
        ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", wt.get("head", "HEAD"), args.remote_main],
                                  cwd=repo, capture_output=True).returncode == 0
        reasons = []
        if not (ancestor or wt.get("branch") in merged_names or wt.get("head") in merged_oids):
            reasons.append("not merged")
        status = run(["git", "status", "--porcelain"], cwd=path, check=False)
        dirty = [l for l in status.splitlines() if DEP_DIR not in l]
        if dirty:
            reasons.append(f"{len(dirty)} uncommitted change(s)")
        if any(c.is_relative_to(path) for c in cwds):
            reasons.append("process running inside")
        if not reasons and recently_changed(path, args.idle_hours):
            reasons.append(f"changed in the last {args.idle_hours:g}h")
        size = 0 if reasons or args.apply else sum(size_bytes(d) for d in deps)
        return path, name, deps, reasons, size

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = [r for r in pool.map(assess, candidates) if r]

    doomed = []
    for path, name, deps, reasons, size in sorted(results, key=lambda r: r[0].name):
        if reasons:
            print(f"keep   {path.name:45} {name}: {', '.join(reasons)}")
        elif args.apply:
            for d in deps:
                aside = d.with_name(f".{DEP_DIR}.deleting-{os.getpid()}")
                os.rename(d, aside)
                doomed.append(aside)
            print(f"delete {path.name:45} {name}: {len(deps)} dir(s)")
        else:
            print(f"would delete {path.name:45} {name}: {len(deps)} dir(s), {size / 2**30:.1f} GiB")

    if args.apply:
        procs = [subprocess.Popen(["rm", "-rf", str(d)]) for d in doomed]
        failed = [d for d, p in zip(doomed, procs) if p.wait() != 0]
        print(f"removed {len(doomed) - len(failed)} of {len(doomed)} dependency directories")
        for d in failed:
            print(f"failed to remove {d}", file=sys.stderr)
    else:
        print(f"would free {sum(r[4] for r in results if not r[3]) / 2**30:.1f} GiB")


if __name__ == "__main__":
    main()
