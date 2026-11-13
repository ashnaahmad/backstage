import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type GitRunner = (
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** A bundle is verified in an empty repo, so recovery never depends on the discarded VM. */
export async function createRecoveryBundle(
  runGit: GitRunner,
  commit: string,
  sourceRef?: string,
): Promise<Buffer> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-bundle-"));
  const bundle = path.join(temp, "work.bundle");
  const verifyRepo = path.join(temp, "verify");
  const git = async (args: string[], timeout = 20000) => {
    const result = await runGit(args, timeout);
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    if ((await git(["rev-parse", "--is-shallow-repository"])) === "true") {
      // Agent commits are not on origin, but the pinned input revision is. Obtain its
      // ancestors before bundling; never publish or pretend a shallow bundle is standalone.
      await git(["fetch", "--unshallow", "origin", ...(sourceRef ? [sourceRef] : [])]);
    }
    await git(["bundle", "create", bundle, "HEAD"]);
    const bundledHead = (await git(["bundle", "list-heads", bundle, "HEAD"])).split(/\s+/)[0];
    if (bundledHead !== commit)
      throw new Error(
        "HEAD changed while preserving the Git checkpoint; retry when the assistant settles",
      );
    await git(["init", "--bare", verifyRepo]);
    await git(["-C", verifyRepo, "bundle", "verify", bundle]);
    return fs.readFileSync(bundle);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
