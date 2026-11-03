import { execFileSync } from 'node:child_process';

// Used only for the Pi-owned live pane: exits when Hunk would show "No changes to review."
// (zero files after all transforms, initially or after a watch refresh). A file filter that
// hides every file leaves the changeset intact, so it does not close. The mark on the owning
// Pi pane, named by this Hunk pane, tells Pi this was not the user closing it. The owner is read
// from this pane when Hunk exits, since a restarted Pi may have adopted it.
export default function closeWhenEmpty(hunk) {
  const pane = process.env.TMUX_PANE;
  if (!process.env.PI_DIFF_OWNER || !pane) return;
  hunk.transformChangeset(changeset => {
    if (changeset.files.length > 0) return changeset;
    try {
      const tagged = execFileSync('tmux', ['show-options', '-pqv', '-t', pane, '@pi_diff_owner'], { encoding: 'utf8' }).trim();
      execFileSync('tmux', ['set-option', '-p', '-t', tagged || process.env.PI_DIFF_OWNER, `@pi_diff_empty_${pane.slice(1)}`, '1'], { stdio: 'ignore' });
    } catch {}
    process.exit(0);
  });
}
