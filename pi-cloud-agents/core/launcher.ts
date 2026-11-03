/**
 * Cloud Agent Launch Orchestrator (T4.4).
 * Handles repository discovery, git dirty check, model validation, LaunchPayload formation,
 * concurrency limiting, initial manifest & index persistence, MicroVM provisioning,
 * status readiness polling, and initial task prompt dispatch.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { ListMicrovmsCommand, RunMicrovmCommand } from "@aws-sdk/client-lambda-microvms";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { LocalConfig, RepoConfig } from "../shared/config.js";
import {
  type LaunchPayload,
  type ProtocolError,
  type RunManifest,
  assertPayloadFits,
} from "../shared/protocol.js";
import { AwsClientFactory, mapAwsError } from "./aws/clients.js";
import { MicrovmImageManager } from "./aws/image.js";
import { collectPages } from "./aws/paginate.js";
import { formatGitHubSecretName } from "./aws/secrets.js";
import { RunClient } from "./client/run-client.js";
import { loadLocalConfig, loadRepoConfig } from "./config.js";
import { DEFAULT_STACK_NAME } from "./sync.js";

export class LaunchError extends Error {
  readonly code: string;
  readonly remediation?: string;
  /** Set when the MicroVM was created before the failure, so the caller can terminate it. */
  readonly microvmId?: string;

  constructor(
    message: string,
    options: { code: string; remediation?: string; microvmId?: string },
  ) {
    super(message);
    this.name = "LaunchError";
    this.code = options.code;
    this.remediation = options.remediation;
    this.microvmId = options.microvmId;
  }
}

export interface GitRepoInfo {
  remoteUrl: string;
  currentBranch: string;
  isDirty: boolean;
  dirtyFilesCount: number;
}

/**
 * Inspects local git repository status for remote URL, current branch, and dirty tree.
 */
export function inspectGitRepo(repoDir = process.cwd()): GitRepoInfo {
  try {
    let remoteUrl = "";
    try {
      remoteUrl = execSync("git remote get-url origin", { cwd: repoDir, encoding: "utf8" }).trim();
    } catch {
      try {
        remoteUrl = execSync("git config --get remote.origin.url", {
          cwd: repoDir,
          encoding: "utf8",
        }).trim();
      } catch {}
    }

    let currentBranch = "main";
    try {
      currentBranch = execSync("git branch --show-current", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      if (!currentBranch) {
        currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: repoDir,
          encoding: "utf8",
        }).trim();
      }
    } catch {
      currentBranch = "main";
    }

    let isDirty = false;
    let dirtyFilesCount = 0;
    try {
      const statusOut = execSync("git status --porcelain", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      if (statusOut) {
        isDirty = true;
        dirtyFilesCount = statusOut.split("\n").filter(Boolean).length;
      }
    } catch {}

    return {
      remoteUrl,
      currentBranch: currentBranch || "main",
      isDirty,
      dirtyFilesCount,
    };
  } catch (err: unknown) {
    throw new LaunchError(
      `Failed to inspect git repository at '${repoDir}': ${(err as Error).message}`,
      {
        code: "GIT_INSPECT_FAILED",
        remediation:
          "Ensure the current workspace is a valid git repository with a configured remote origin.",
      },
    );
  }
}

/**
 * Generates a valid unique runId matching format run-[a-z0-9-]+.
 */
export function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${ts}-${rand}`;
}

export interface LaunchRunOptions {
  prompt: string;
  repoDir?: string;
  config?: LocalConfig;
  piAgentDir?: string;
  clientFactory?: AwsClientFactory;
  model?: { provider: string; id: string };
  enableShell?: boolean;
  workBranch?: string;
  depth?: number;
  installTimeoutSec?: number;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  onProgress?: (step: string, detail?: string) => void;
  dryRun?: boolean;
  /** Overrides `defaults.maxDurationHours` for this run (seconds, at most 8 hours). */
  maxDurationSec?: number;
  /** Defaults to true: finalize pushes the work branch. */
  autoPush?: boolean;
}

/**
 * Everything needed to start a run, resolved locally from the repository, local config and
 * stack outputs. Plain JSON, so it can be stored and started later from another host
 * (the scheduled-task launcher); it holds secret names, never secret values.
 */
export interface PreparedLaunch {
  payload: LaunchPayload;
  manifest: RunManifest;
  region: string;
  profile?: string;
  imageArn: string;
  imageVersion: string;
  executionRoleArn?: string;
  imageLogGroup: string;
  maxConcurrent: number;
  maxDurationSec: number;
  suspendedDurationSec: number;
  egressConnectorArn?: string;
}

export interface StartRunOptions {
  prompt: string;
  clientFactory?: AwsClientFactory;
  enableShell?: boolean;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  onProgress?: (step: string, detail?: string) => void;
  dryRun?: boolean;
}

export interface LaunchRunResult {
  runId: string;
  microvmId: string;
  endpoint: string;
  workBranch: string;
  manifest: RunManifest;
  warnings: string[];
  /** Whether the initial prompt reached the runner; otherwise the VM is idle without a task. */
  promptDispatched?: boolean;
}

interface CoreStackResources {
  bucket: string;
  /** Role the MicroVM guest runs as; without it the runner has no AWS credentials. */
  executionRoleArn?: string;
  imageLogGroup?: string;
}

/**
 * Resolves the S3 storage bucket, guest execution role and image log group from the core stack outputs.
 */
async function resolveCoreStackResources(
  cfnClient: import("@aws-sdk/client-cloudformation").CloudFormationClient,
  stackName: string,
): Promise<CoreStackResources> {
  try {
    const res = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs = res.Stacks?.[0]?.Outputs ?? [];
    const output = (...keys: string[]) =>
      outputs.find((o) => o.OutputKey && keys.includes(o.OutputKey))?.OutputValue;
    const bucket = output("BucketName", "StorageBucketName", "S3BucketName");
    if (bucket) {
      return {
        bucket,
        executionRoleArn: output("ExecutionRoleArn"),
        imageLogGroup: output("ImageLogGroup"),
      };
    }
  } catch (err) {
    throw new LaunchError(
      `Failed to describe stack '${stackName}': ${(err as Error).message}. Ensure setup completed successfully.`,
      {
        code: "STACK_NOT_FOUND",
        remediation:
          "Run '/cloud setup' or 'npx pi-cloud-agents setup' to create the required infrastructure.",
      },
    );
  }

  throw new LaunchError(
    `CloudFormation stack '${stackName}' has no BucketName output. Re-run setup.`,
    {
      code: "BUCKET_OUTPUT_MISSING",
      remediation: "Re-deploy infrastructure with '/cloud setup'.",
    },
  );
}

/**
 * Writes or updates the RunManifest in S3.
 */
export async function writeManifestToS3(
  s3Client: S3Client,
  bucket: string,
  manifest: RunManifest,
): Promise<void> {
  const key = `runs/${manifest.runId}/manifest.json`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
    }),
  );
}

/**
 * Writes the index lookup object in S3 mapping microvmId to runId.
 */
export async function writeIndexToS3(
  s3Client: S3Client,
  bucket: string,
  microvmId: string,
  runId: string,
): Promise<void> {
  const key = `index/${microvmId}`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(
        {
          runId,
          microvmId,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
    }),
  );
}

/**
 * Main launch orchestrator for starting a cloud agent run.
 */
export async function launchCloudRun(options: LaunchRunOptions): Promise<LaunchRunResult> {
  const { prepared, warnings } = await prepareCloudRun(options);
  const result = await startPreparedRun(prepared, {
    prompt: options.prompt,
    clientFactory: options.clientFactory,
    enableShell: options.enableShell,
    pollIntervalMs: options.pollIntervalMs,
    readyTimeoutMs: options.readyTimeoutMs,
    onProgress: options.onProgress,
    dryRun: options.dryRun,
  });
  return { ...result, warnings: [...warnings, ...result.warnings] };
}

/**
 * Resolves the launch locally: repository, model, repo config, stack outputs and image version.
 * Writes nothing.
 */
export async function prepareCloudRun(
  options: Omit<LaunchRunOptions, "prompt"> & { prompt?: string },
): Promise<{ prepared: PreparedLaunch; warnings: string[] }> {
  const warnings: string[] = [];
  const repoDir = options.repoDir ? path.resolve(options.repoDir) : process.cwd();
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });

  // 1. Git Repository Inspection
  options.onProgress?.("inspect_repo", "Detecting git repository and current branch");
  const gitInfo = inspectGitRepo(repoDir);
  if (!gitInfo.remoteUrl) {
    throw new LaunchError(
      `No git remote 'origin' found in repository at '${repoDir}'. Cloud agents require a remote repository URL.`,
      {
        code: "REMOTE_ORIGIN_MISSING",
        remediation:
          "Add a git remote origin using 'git remote add origin <url>' and push your branch.",
      },
    );
  }

  if (gitInfo.isDirty) {
    const warnMsg = `Warning: ${gitInfo.dirtyFilesCount} uncommitted local change(s) detected. Cloud agents will clone from '${gitInfo.remoteUrl}' (${gitInfo.currentBranch}).`;
    warnings.push(warnMsg);
    options.onProgress?.("git_warning", warnMsg);
  }

  // 2. Model Selection & Credential Sync Check
  const model = options.model || config.defaults.model;
  const syncedProviders = new Set(config.providers.synced || []);

  if (!syncedProviders.has(model.provider) && !config.providers.bedrockRole) {
    throw new LaunchError(
      `Selected model provider '${model.provider}' is not synced to AWS Secrets Manager and Bedrock role is not enabled.`,
      {
        code: "PROVIDER_NOT_SYNCED",
        remediation: `Run '/cloud sync' to synchronize ${model.provider} API keys or enable Bedrock via '/cloud config providers.bedrockRole true'.`,
      },
    );
  }

  // 3. Read RepoConfig (.pi/cloud-agents.json) if present
  const repoConfig: RepoConfig | null = loadRepoConfig(repoDir);

  // 4. Resolve stack outputs and the active image version
  const lambdaMicrovmsClient = factory.getLambdaMicrovmsClient({ region, profile });
  const cfnClient = factory.getCloudFormationClient({ region, profile });
  const s3Client = factory.getS3Client({ region, profile });

  const imageName = config.image.name || "pi-cloud-agents-runner";
  const {
    bucket,
    executionRoleArn,
    imageLogGroup = `/aws/lambda/microvms/${imageName}`,
  } = await resolveCoreStackResources(cfnClient, stackName);

  const imageManager = new MicrovmImageManager({
    microvmsClient: lambdaMicrovmsClient,
    s3Client,
    region,
  });
  const imageDesc = await imageManager.describeImage(imageName);

  if (!imageDesc.arn || !imageDesc.version) {
    throw new LaunchError(
      `MicroVM runner image '${imageName}' has no active deployed version in region ${region}.`,
      {
        code: "IMAGE_NOT_ACTIVE",
        remediation: "Deploy the runner image using '/cloud setup' or '/cloud update'.",
      },
    );
  }

  const imageArn = imageDesc.arn;
  const imageVersion = imageDesc.version;

  // 5. Construct LaunchPayload
  const runId = generateRunId();
  const workBranch = options.workBranch || `pi-cloud/${runId}`;

  const resolvedInstallTimeout = options.installTimeoutSec || (repoConfig ? 600 : 300);
  const maxDurationSec = options.maxDurationSec ?? (config.defaults.maxDurationHours || 4) * 3600;
  const suspendAfterIdleSec = (config.defaults.idle.suspendAfterMin || 15) * 60;
  const terminateAfterSuspendedSec = (config.defaults.idle.terminateAfterSuspendedMin || 120) * 60;

  const payload: LaunchPayload = {
    v: 1,
    runId,
    owner: profile || "pi-user",
    stack: {
      name: stackName,
      region,
      bucket,
    },
    repo: {
      url: gitInfo.remoteUrl,
      ref: gitInfo.currentBranch,
      workBranch,
      depth: options.depth || 1,
    },
    model: {
      provider: model.provider,
      id: model.id,
    },
    piConfig: {
      bundleKey: "config/bundle.tar",
      authParams: Array.from(syncedProviders) as string[],
      bedrockRole: config.providers.bedrockRole,
    },
    github:
      config.github.mode === "secret"
        ? { mode: "secret", name: formatGitHubSecretName(stackName) }
        : { mode: "none" },
    options: {
      installTimeoutSec: resolvedInstallTimeout,
      trustProjectConfig: true,
      idleGraceSec: suspendAfterIdleSec,
      suspendAfterIdleSec,
      terminateAfterSuspendedSec,
      autoPush: options.autoPush ?? true,
      maxDurationSec,
    },
    logGroup: `/aws/lambda/microvms/${imageName}`,
  };

  // Assert payload size fits the 3.5 KB budget
  assertPayloadFits(payload);

  const nowIso = new Date().toISOString();
  const manifest: RunManifest = {
    v: 1,
    runId,
    owner: payload.owner,
    status: "launching",
    createdAt: nowIso,
    updatedAt: nowIso,
    imageVersion,
    repo: {
      url: gitInfo.remoteUrl,
      ref: gitInfo.currentBranch,
      workBranch,
    },
    model: {
      provider: model.provider,
      id: model.id,
    },
    git: {
      workBranch,
    },
    timeline: [{ status: "launching", at: nowIso }],
  };

  return {
    prepared: {
      payload,
      manifest,
      region,
      profile,
      imageArn,
      imageVersion,
      executionRoleArn,
      imageLogGroup,
      maxConcurrent: config.defaults.maxConcurrent ?? 3,
      maxDurationSec,
      suspendedDurationSec: terminateAfterSuspendedSec,
      egressConnectorArn: config.egressConnectorArn,
    },
    warnings,
  };
}

/**
 * Starts a prepared run: concurrency check, initial manifest, RunMicrovm, index, readiness
 * polling and the initial prompt. Needs only AWS credentials, not the local checkout or config.
 */
export async function startPreparedRun(
  prepared: PreparedLaunch,
  options: StartRunOptions,
): Promise<LaunchRunResult> {
  const warnings: string[] = [];
  const { payload, region, profile, imageArn, imageVersion, executionRoleArn, imageLogGroup } =
    prepared;
  const { runId } = payload;
  const { bucket } = payload.stack;
  const workBranch = payload.repo.workBranch;
  const stackName = payload.stack.name;
  let manifest = prepared.manifest;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });
  const lambdaMicrovmsClient = factory.getLambdaMicrovmsClient({ region, profile });
  const s3Client = factory.getS3Client({ region, profile });

  options.onProgress?.("check_concurrency", "Checking active MicroVM concurrency");
  // Query active running/suspended MicroVMs
  try {
    const imageVms = await collectPages({
      fetchPage: (nextToken: string | undefined) =>
        lambdaMicrovmsClient.send(
          new ListMicrovmsCommand({ imageIdentifier: imageArn, nextToken }),
        ),
      nextToken: (page) => page.nextToken,
      items: (page) => page.items,
    });
    const activeVms = imageVms.filter((vm) => vm.state === "RUNNING" || vm.state === "SUSPENDED");

    const maxConcurrent = prepared.maxConcurrent;
    if (activeVms.length >= maxConcurrent) {
      throw new LaunchError(
        `Active cloud agent runs limit reached (${activeVms.length}/${maxConcurrent} active VMs).`,
        {
          code: "CONCURRENCY_LIMIT_EXCEEDED",
          remediation: `Wait for an active run to finish, terminate an idle run with '/cloud stop <id>', or increase concurrency limit via '/cloud config defaults.maxConcurrent <n>'.`,
        },
      );
    }
  } catch (err: unknown) {
    if ((err as Error) instanceof LaunchError) throw err;
    // Non-fatal if list check fails due to permissions, proceed to launch
  }

  // 6. Write Initial Manifest to S3
  options.onProgress?.(
    "write_manifest",
    `Creating initial run manifest 'runs/${runId}/manifest.json'`,
  );
  await writeManifestToS3(s3Client, bucket, manifest);

  if (options.dryRun) {
    return {
      runId,
      microvmId: "vm-dryrun-000000000000",
      endpoint: "dryrun.lambda-microvms.us-east-1.amazonaws.com",
      workBranch,
      manifest,
      warnings,
    };
  }

  // 7. Invoke RunMicrovmCommand
  options.onProgress?.("run_microvm", `Provisioning Lambda MicroVM with image '${imageArn}'`);
  let microvmId = "";
  let endpoint = "";

  try {
    const runRes = await lambdaMicrovmsClient.send(
      new RunMicrovmCommand({
        imageIdentifier: imageArn,
        imageVersion,
        clientToken: runId,
        executionRoleArn,
        logging: { cloudWatch: { logGroup: imageLogGroup } },
        maximumDurationInSeconds: prepared.maxDurationSec,
        idlePolicy: {
          maxIdleDurationSeconds: 1200,
          suspendedDurationSeconds: prepared.suspendedDurationSec,
          autoResumeEnabled: true,
        },
        runHookPayload: JSON.stringify(payload),
        ingressNetworkConnectors: options.enableShell
          ? [
              `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
              `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:SHELL_INGRESS`,
            ]
          : [`arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`],
        egressNetworkConnectors: prepared.egressConnectorArn
          ? [prepared.egressConnectorArn]
          : [
              `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
            ],
      }),
    );

    microvmId = runRes.microvmId || "";
    endpoint = runRes.endpoint || "";

    if (!microvmId || !endpoint) {
      throw new Error("RunMicrovm succeeded but returned missing microvmId or endpoint");
    }

    // Write index lookup in S3
    await writeIndexToS3(s3Client, bucket, microvmId, runId);

    // Update manifest with microvmId and endpoint
    manifest = {
      ...manifest,
      microvmId,
      endpoint,
      updatedAt: new Date().toISOString(),
    };
    await writeManifestToS3(s3Client, bucket, manifest);
  } catch (err: unknown) {
    const errorIso = new Date().toISOString();
    const mappedErr = mapAwsError(err, { region, stackName, action: "RunMicrovm" });
    const protocolErr: ProtocolError = {
      code: mappedErr.code || "MICROVM_LAUNCH_FAILED",
      message: mappedErr.message,
    };

    manifest = {
      ...manifest,
      status: "failed",
      error: protocolErr,
      updatedAt: errorIso,
      timeline: [
        ...manifest.timeline,
        { status: "failed", at: errorIso, reason: mappedErr.message },
      ],
    };
    await writeManifestToS3(s3Client, bucket, manifest).catch(() => {});

    throw new LaunchError(`Failed to launch MicroVM: ${mappedErr.message}`, {
      code: mappedErr.code,
      remediation: mappedErr.remediation,
      microvmId: microvmId || undefined,
    });
  }

  // 8. Poll /v1/status until ready and submit initial prompt
  options.onProgress?.(
    "wait_ready",
    `Connecting to runner at ${endpoint} and waiting for ready status`,
  );
  const runClient = new RunClient({
    endpoint,
    microvmIdentifier: microvmId,
    region,
    profile,
    microvmsClient: lambdaMicrovmsClient,
    clientFactory: factory,
  });

  const pollInterval = options.pollIntervalMs || 2000;
  const readyTimeout = options.readyTimeoutMs || 5 * 60 * 1000; // 5 min
  const deadline = Date.now() + readyTimeout;
  let isReady = false;
  let promptDispatched = false;

  while (Date.now() <= deadline) {
    try {
      const statusRes = await runClient.getStatus();
      if (
        statusRes.status === "ready" ||
        statusRes.status === "idle" ||
        statusRes.status === "running"
      ) {
        isReady = true;
        break;
      }
      if (statusRes.status === "failed") {
        throw new Error("Runner initialized in failed state");
      }
      options.onProgress?.("provisioning", `Runner status: ${statusRes.status}...`);
    } catch {
      // Runner may still be booting
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  if (!isReady) {
    warnings.push(
      `Runner at '${endpoint}' did not report 'ready' within ${Math.round(readyTimeout / 1000)}s. Initial prompt submission deferred.`,
    );
  } else {
    // 9. Submit initial user prompt
    options.onProgress?.("submit_prompt", "Dispatching initial task prompt to cloud agent");
    try {
      await runClient.prompt({
        prompt: options.prompt,
        mode: "prompt",
      });
      promptDispatched = true;
      options.onProgress?.("prompt_dispatched", "Prompt dispatched successfully.");
    } catch (err: unknown) {
      warnings.push(
        `Failed to dispatch initial prompt: ${(err as Error).message}. Attach with '/cloud attach ${runId}' to retry.`,
      );
    }
  }

  return {
    runId,
    microvmId,
    endpoint,
    workBranch,
    manifest,
    warnings,
    promptDispatched,
  };
}
