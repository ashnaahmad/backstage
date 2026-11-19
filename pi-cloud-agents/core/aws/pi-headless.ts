/**
 * Pinned Pi runtime constants and static image checks.
 * The guest image installs the pinned Pi version; `pi-cloud-agents doctor` reports it and
 * unit tests validate the real image/Dockerfile. Real Pi turns with the mock provider are
 * exercised by tests/integration/assignment-round-trip.test.ts.
 */

export const PINNED_PI_VERSION = "1.4.0";
export const MIN_NODE_VERSION = "22.19.0";

export interface DockerfileValidationResult {
  valid: boolean;
  hasBaseImage: boolean;
  hasNode22: boolean;
  hasRequiredPackages: boolean;
  hasPinnedPiVersion: boolean;
  hasDirectoryStructure: boolean;
  hasHookPortEnv: boolean;
  hasWorkdir: boolean;
  errors: string[];
}

/**
 * Validates Dockerfile content against requirements for ARM64 AL2023 base image.
 */
export function validateDockerfile(content: string): DockerfileValidationResult {
  const errors: string[] = [];
  const hasBaseImage =
    /FROM\s+(public\.ecr\.aws\/lambda\/microvms:al2023-minimal|arn:aws:lambda:[^:]+:[^:]+:microvm-image:[^\s]+)/i.test(
      content,
    );
  if (!hasBaseImage) errors.push("Missing or invalid base image (expected al2023-minimal base)");

  const hasNode22 = /nodejs22|node:22|node@22/i.test(content);
  if (!hasNode22) errors.push("Missing Node.js 22 package installation in Dockerfile");

  const hasGit = /git/i.test(content);
  const hasTar = /tar/i.test(content);
  const hasGzip = /gzip/i.test(content);
  const hasWhich = /which/i.test(content);
  const hasFindutils = /findutils/i.test(content);
  const hasProcps = /procps/i.test(content);
  const hasRequiredPackages = hasGit && hasTar && hasGzip && hasWhich && hasFindutils && hasProcps;
  if (!hasRequiredPackages)
    errors.push(
      "Missing one or more required OS packages: git, tar, gzip, which, findutils, procps-ng",
    );

  const hasPinnedPiVersion = content.includes(
    `@earendil-works/pi-coding-agent@${PINNED_PI_VERSION}`,
  );
  if (!hasPinnedPiVersion)
    errors.push(`Missing pinned @earendil-works/pi-coding-agent@${PINNED_PI_VERSION} installation`);

  const hasDirectoryStructure =
    content.includes("/opt/pi-cloud") &&
    content.includes("/root/.pi/agent") &&
    content.includes("/workspace");
  if (!hasDirectoryStructure)
    errors.push("Missing required directory structure: /opt/pi-cloud, /root/.pi/agent, /workspace");

  const hasHookPortEnv = /ENV\s+HOOK_PORT=9000/i.test(content) || /HOOK_PORT=9000/i.test(content);
  if (!hasHookPortEnv) errors.push("Missing HOOK_PORT=9000 environment configuration");

  const hasWorkdir = /WORKDIR\s+\/workspace/i.test(content) || /WORKDIR\s+\/work/i.test(content);
  if (!hasWorkdir) errors.push("Missing WORKDIR configuration");

  return {
    valid: errors.length === 0,
    hasBaseImage,
    hasNode22,
    hasRequiredPackages,
    hasPinnedPiVersion,
    hasDirectoryStructure,
    hasHookPortEnv,
    hasWorkdir,
    errors,
  };
}

/**
 * Validates whether a Node.js version string satisfies >= 22.19.0.
 */
export function isNodeVersionValid(versionStr: string, minVersion = MIN_NODE_VERSION): boolean {
  const clean = versionStr.replace(/^v/, "").trim();
  const parts = clean.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const minParts = minVersion.split(".").map((n) => Number.parseInt(n, 10) || 0);

  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;

  const minMajor = minParts[0] ?? 0;
  const minMinor = minParts[1] ?? 0;
  const minPatch = minParts[2] ?? 0;

  if (major > minMajor) return true;
  if (major === minMajor) {
    if (minor > minMinor) return true;
    if (minor === minMinor) return patch >= minPatch;
  }
  return false;
}

/**
 * Validates whether a CPU architecture matches ARM64 (aarch64 / arm64).
 */
export function isArm64Architecture(archStr: string): boolean {
  const normalized = archStr.trim().toLowerCase();
  return normalized === "aarch64" || normalized === "arm64";
}
