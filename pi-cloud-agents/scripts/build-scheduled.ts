/**
 * Builds the scheduled one-shot task pieces:
 *  - dist/scheduled/launcher.zip: the launch Lambda, fully bundled (the Lambda runtime's SDK
 *    does not ship every client this needs, e.g. lambda-microvms)
 *  - dist/scheduled/cli.js: the local helper pi-tick's AWS backend calls; packages stay external
 *    and resolve from this package's node_modules
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { createDeterministicZip } from "../core/aws/zip.js";
import { DETERMINISTIC_BUILD_DATE } from "./build-image-zip.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(REPO_ROOT, "dist", "scheduled");
fs.mkdirSync(outDir, { recursive: true });

const handlerOut = path.join(outDir, "launcher", "index.mjs");
await esbuild.build({
  entryPoints: [path.join(REPO_ROOT, "scheduled", "handler.ts")],
  outfile: handlerOut,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "warning",
});
const zip = createDeterministicZip(
  [
    {
      name: "index.mjs",
      content: fs.readFileSync(handlerOut),
      mode: 0o644,
      mtime: DETERMINISTIC_BUILD_DATE,
    },
  ],
  { defaultMtime: DETERMINISTIC_BUILD_DATE },
);
const zipPath = path.join(outDir, "launcher.zip");
fs.writeFileSync(zipPath, zip);

const cliOut = path.join(outDir, "cli.js");
await esbuild.build({
  entryPoints: [path.join(REPO_ROOT, "scheduled", "cli.ts")],
  outfile: cliOut,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  logLevel: "warning",
});

console.log(`${path.relative(REPO_ROOT, zipPath)} (${zip.length} bytes)`);
console.log(path.relative(REPO_ROOT, cliOut));
