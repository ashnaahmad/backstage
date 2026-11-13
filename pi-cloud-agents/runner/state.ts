/**
 * Run State Machine and Persistence.
 * Implements MicroVM lifecycle state transitions, timeline management,
 * token usage tracking, and storage synchronization (manifest and debounced session mirroring).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  type LaunchPayload,
  type ManifestGit,
  type ManifestUsage,
  type ProtocolError,
  type RunManifest,
  RunManifestSchema,
  type RunStatus,
  encodeRunManifest,
} from "../shared/protocol.js";
import type { Logger } from "./logger.js";
import { redactText } from "./pi-extensions/redact.js";
import type { StorageSink } from "./storage.js";

/**
 * Valid state transitions for a cloud agent run.
 */
export const VALID_STATUS_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  launching: ["running", "failed", "terminated"],
  running: ["idle", "suspended", "completed", "failed", "terminated"],
  idle: ["running", "suspended", "completed", "failed", "terminated"],
  suspended: ["running", "failed", "terminated"],
  completed: [],
  failed: [],
  terminated: [],
};

export class InvalidStateTransitionError extends Error {
  public readonly from: RunStatus;
  public readonly to: RunStatus;

  constructor(from: RunStatus, to: RunStatus, message?: string) {
    super(
      message ??
        `Invalid run state transition from '${from}' to '${to}'. Allowed targets: [${(
          VALID_STATUS_TRANSITIONS[from] || []
        ).join(", ")}]`,
    );
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

export interface RunStateMachineOptions {
  storageSink: StorageSink;
  manifest?: RunManifest;
  payload?: LaunchPayload;
  imageVersion?: string;
  microvmId?: string;
  endpoint?: string;
  logger?: Logger;
  sessionDebounceMs?: number;
}

/**
 * Helper to construct the initial RunManifest from a LaunchPayload.
 */
export function createInitialManifest(
  payload: LaunchPayload,
  options?: {
    imageVersion?: string;
    microvmId?: string;
    endpoint?: string;
    status?: RunStatus;
  },
): RunManifest {
  const now = new Date().toISOString();
  const status: RunStatus = options?.status ?? "launching";

  const manifest: RunManifest = {
    v: 1,
    runId: payload.runId,
    owner: payload.owner,
    status,
    createdAt: now,
    updatedAt: now,
    imageVersion: options?.imageVersion ?? process.env.AWS_LAMBDA_MICROVM_IMAGE_VERSION ?? "1.0",
    microvmId: options?.microvmId,
    endpoint: options?.endpoint,
    repo: {
      url: payload.repo.url,
      ref: payload.repo.ref,
      workBranch: payload.repo.workBranch,
    },
    model: {
      provider: payload.model.provider,
      id: payload.model.id,
    },
    timeline: [
      {
        status,
        at: now,
        reason: "Run initialized",
      },
    ],
  };

  return RunManifestSchema.parse(manifest);
}

export class RunStateMachine {
  private manifest: RunManifest;
  private readonly storageSink: StorageSink;
  private readonly logger?: Logger;
  private readonly sessionDebounceMs: number;

  private readonly manifestKey: string;
  private readonly sessionKey: string;

  private sessionBuffer: Buffer = Buffer.alloc(0);
  private sessionDirty = false;
  private sessionDebounceTimer: NodeJS.Timeout | null = null;
  private trackedSessionFilePath?: string;
  private sessionWrite: Promise<void> = Promise.resolve();
  private manifestWrite: Promise<void> = Promise.resolve();

  constructor(options: RunStateMachineOptions) {
    this.storageSink = options.storageSink;
    this.logger = options.logger;
    this.sessionDebounceMs = options.sessionDebounceMs ?? 5000;

    if (options.manifest) {
      this.manifest = RunManifestSchema.parse(options.manifest);
    } else if (options.payload) {
      this.manifest = createInitialManifest(options.payload, {
        imageVersion: options.imageVersion,
        microvmId: options.microvmId,
        endpoint: options.endpoint,
      });
    } else {
      throw new Error("RunStateMachine requires either an existing manifest or a LaunchPayload");
    }

    this.manifestKey = `runs/${this.manifest.runId}/manifest.json`;
    this.sessionKey = `runs/${this.manifest.runId}/session.jsonl`;
  }

  public getManifest(): Readonly<RunManifest> {
    return this.manifest;
  }

  public getStatus(): RunStatus {
    return this.manifest.status;
  }

  public getRunId(): string {
    return this.manifest.runId;
  }

  /**
   * Validates and performs a lifecycle state transition.
   * Flushes pending session lines and persists the updated manifest.
   */
  public async transitionTo(to: RunStatus, reason?: string): Promise<RunManifest> {
    const from = this.manifest.status;

    if (from === to) {
      return this.manifest;
    }

    const allowedTargets = VALID_STATUS_TRANSITIONS[from];
    if (!allowedTargets || !allowedTargets.includes(to)) {
      throw new InvalidStateTransitionError(from, to);
    }

    const now = new Date().toISOString();
    this.manifest.status = to;
    this.manifest.updatedAt = now;
    this.manifest.timeline.push({
      status: to,
      at: now,
      reason,
    });

    this.logger?.info?.(
      `Transitioned run '${this.manifest.runId}' state: ${from} -> ${to}${reason ? ` (${reason})` : ""}`,
    );

    await this.persistManifest();

    return this.manifest;
  }

  /**
   * Appends a custom progress or milestone entry to the timeline without changing the run status.
   */
  public async recordTimeline(status: string, reason?: string): Promise<void> {
    const now = new Date().toISOString();
    this.manifest.updatedAt = now;
    this.manifest.timeline.push({
      status,
      at: now,
      reason,
    });

    await this.persistManifest();
  }

  /**
   * Updates token usage metrics.
   */
  public async updateUsage(usage: Partial<ManifestUsage>): Promise<void> {
    const currentUsage = this.manifest.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    const updated: ManifestUsage = {
      inputTokens: usage.inputTokens ?? currentUsage.inputTokens,
      outputTokens: usage.outputTokens ?? currentUsage.outputTokens,
      totalTokens:
        usage.totalTokens ??
        (usage.inputTokens ?? currentUsage.inputTokens) +
          (usage.outputTokens ?? currentUsage.outputTokens),
      estimatedCostUsd: usage.estimatedCostUsd ?? currentUsage.estimatedCostUsd,
    };

    this.manifest.usage = updated;
    this.manifest.updatedAt = new Date().toISOString();
    await this.persistManifest();
  }

  /**
   * Updates git repository metadata (last commit, PR URL, work branch).
   */
  public async updateGit(git: Partial<ManifestGit>): Promise<void> {
    const currentGit = this.manifest.git ?? {
      workBranch: this.manifest.repo.workBranch,
    };

    this.manifest.git = {
      workBranch: git.workBranch ?? currentGit.workBranch,
      lastCommit: git.lastCommit ?? currentGit.lastCommit,
      recovery: git.recovery ?? currentGit.recovery,
      prUrl: git.prUrl ?? currentGit.prUrl,
    };
    this.manifest.updatedAt = new Date().toISOString();
    await this.persistManifest();
  }

  /**
   * Updates last seen entry ID from the pi RPC stream.
   */
  public recordLastEntryId(entryId: string): void {
    if (entryId && entryId.trim().length > 0) {
      this.manifest.lastEntryId = entryId;
    }
  }

  /** Publish immutable Git contents before advertising their recovery reference. */
  public async preserveGitBundle(bundle: Buffer, commit: string): Promise<void> {
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    const key = `runs/${this.manifest.runId}/artifacts/git-${sha256}.bundle`;
    await this.retryOperation(
      () => this.storageSink.putObject(key, bundle, "application/octet-stream"),
      3,
    );
    this.clearErrorForStage("git_preservation");
    await this.updateGit({ recovery: { key, commit, sha256 } });
  }

  /** Clear only a recovered operation's error, never an unrelated run failure. */
  public clearErrorForStage(stage: string): void {
    if (
      this.manifest.error?.code === "INTERNAL_ERROR" &&
      (this.manifest.error.details as { stage?: string } | undefined)?.stage === stage
    )
      this.manifest.error = undefined;
  }

  /**
   * Sets error details on the manifest.
   */
  public setError(error: ProtocolError): void {
    this.manifest.error = error;
    this.manifest.updatedAt = new Date().toISOString();
  }

  /**
   * Links a local pi session file to be mirrored to storage.
   */
  public trackSessionFile(filePath: string): void {
    this.trackedSessionFilePath = filePath;
  }

  /**
   * Returns the linked local pi session file path if configured.
   */
  public getTrackedSessionFilePath(): string | undefined {
    return this.trackedSessionFilePath;
  }

  /**
   * Appends raw session chunk (e.g. JSONL lines) to in-memory buffer and schedules debounced flush.
   */
  public appendSessionChunk(chunk: string | Buffer): void {
    const rawStr = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const sanitizedStr = redactText(rawStr);
    const buffer = Buffer.from(sanitizedStr, "utf8");
    this.sessionBuffer = Buffer.concat([this.sessionBuffer, buffer]);
    this.sessionDirty = true;
    this.scheduleDebouncedSessionFlush();
  }

  /** RPC events signal file changes; they are not session JSONL records. */
  public scheduleSessionMirror(): void {
    this.scheduleDebouncedSessionFlush();
  }

  private scheduleDebouncedSessionFlush(): void {
    if (this.sessionDebounceTimer) {
      return;
    }

    this.sessionDebounceTimer = setTimeout(() => {
      this.sessionDebounceTimer = null;
      this.flushSession().catch((err) => {
        this.logger?.error?.(
          `Debounced session flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.sessionDebounceMs);
  }

  /**
   * Immediately flushes session content to storage sink.
   * Reads from tracked local session file if available, otherwise writes accumulated buffer.
   */
  public flushSession(): Promise<void> {
    const next = this.sessionWrite.then(
      () => this.writeSession(),
      () => this.writeSession(),
    );
    this.sessionWrite = next;
    return next;
  }

  private async writeSession(): Promise<void> {
    if (this.sessionDebounceTimer) {
      clearTimeout(this.sessionDebounceTimer);
      this.sessionDebounceTimer = null;
    }

    let payloadToUpload: Buffer | null = null;

    if (this.trackedSessionFilePath && fs.existsSync(this.trackedSessionFilePath)) {
      try {
        payloadToUpload = fs.readFileSync(this.trackedSessionFilePath);
      } catch (err) {
        this.logger?.warn?.(
          `Failed to read tracked session file '${this.trackedSessionFilePath}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!payloadToUpload && this.sessionDirty) {
      payloadToUpload = this.sessionBuffer;
    }

    if (payloadToUpload) {
      // Redact any secrets before uploading to storage sink
      const rawText = payloadToUpload.toString("utf8");
      const sanitizedText = redactText(rawText);
      payloadToUpload = Buffer.from(sanitizedText, "utf8");

      try {
        await this.retryOperation(
          () =>
            this.storageSink.putObject(
              this.sessionKey,
              payloadToUpload as Buffer,
              "application/x-ndjson",
            ),
          3,
        );
        this.sessionDirty = false;
        this.logger?.debug?.(
          `Flushed session mirror for run '${this.manifest.runId}' (${payloadToUpload.length} bytes)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.error?.(`Failed to flush session mirror '${this.sessionKey}': ${msg}`);
        throw err;
      }
    }
  }

  /**
   * Persists the current RunManifest to the storage sink.
   */
  public persistManifest(): Promise<void> {
    const next = this.manifestWrite.then(
      () => this.writeManifest(),
      () => this.writeManifest(),
    );
    this.manifestWrite = next;
    return next;
  }

  private async writeManifest(): Promise<void> {
    // All writers (including metrics/Git updates) must publish durable transcript first
    // when advertising a settled, suspended or terminal state.
    if (["idle", "suspended", "completed", "failed", "terminated"].includes(this.manifest.status)) {
      await this.flushSession();
    }
    const validated = RunManifestSchema.parse(this.manifest);
    const serialized = encodeRunManifest(validated);

    try {
      await this.retryOperation(
        () => this.storageSink.putObject(this.manifestKey, serialized, "application/json"),
        3,
      );
      this.logger?.debug?.(
        `Persisted manifest for run '${this.manifest.runId}' [${this.manifest.status}]`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error?.(`Failed to persist manifest '${this.manifestKey}': ${msg}`);
      throw err;
    }
  }

  /**
   * Marks terminal state (completed, failed, or terminated), recording error if provided,
   * flushing the session file first, and persisting the final manifest.
   */
  public async finalize(
    terminalStatus: "completed" | "failed" | "terminated",
    options?: { error?: ProtocolError; reason?: string },
  ): Promise<RunManifest> {
    if (options?.error) {
      this.setError(options.error);
    }

    return this.transitionTo(terminalStatus, options?.reason);
  }

  private async retryOperation<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    backoffMs = 100,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** (attempt - 1)));
        }
      }
    }
    throw lastError;
  }
}
