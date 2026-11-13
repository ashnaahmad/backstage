import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { RunManifest } from "../shared/protocol.js";
import { AwsClientFactory } from "./aws/clients.js";
import { loadLocalConfig } from "./config.js";
import { resolveBucketName } from "./list.js";
import { DEFAULT_STACK_NAME } from "./sync.js";

export interface FinalMessage {
  text: string;
  timestamp?: string;
  stopReason?: string;
  /** The latest message is a finished assistant response, not an older answer. */
  complete: boolean;
}

/** Read session records, never RPC event frames. Tolerate an interrupted last line. */
export function finalAssistantMessage(sessionJsonl: string): FinalMessage | null {
  let newerMessage = false;
  const lines = sessionJsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: {
      type?: string;
      timestamp?: string;
      message?: { role?: string; stopReason?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (entry?.type !== "message" || !entry.message) continue;
    if (entry.message.role !== "assistant") {
      newerMessage = true;
      continue;
    }
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          part.type === "text" &&
          typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n");
    const stopReason = entry.message.stopReason;
    return {
      text,
      timestamp: entry.timestamp,
      stopReason,
      complete: !newerMessage && stopReason === "stop",
    };
  }
  return null;
}

export function describeResult(
  savedStatus: string,
  final: FinalMessage | null,
  lifecycleStatus = savedStatus,
): "pending" | "settled" | "incomplete" {
  const terminal = ["completed", "failed", "terminated"].includes(lifecycleStatus.toLowerCase());
  if (
    final?.complete &&
    ["idle", "suspended", "completed", "terminated"].includes(savedStatus.toLowerCase())
  )
    return "settled";
  return terminal ? "incomplete" : "pending";
}

export function describeRecovery(manifest: Pick<RunManifest, "git" | "error">, bucket: string) {
  const recovery = manifest.git?.recovery;
  if (!recovery) return null;
  const preservationFailed =
    (manifest.error?.details as { stage?: string } | undefined)?.stage === "git_preservation";
  return {
    ...recovery,
    uri: `s3://${bucket}/${recovery.key}`,
    current: recovery.commit === manifest.git?.lastCommit && !preservationFailed,
  };
}

/** Durable result retrieval works without contacting or resuming the VM. */
export async function fetchRunResult(
  manifest: RunManifest,
  options: { s3Client?: S3Client; bucket?: string; status?: string } = {},
) {
  const config = loadLocalConfig();
  const factory = new AwsClientFactory({ region: config.aws.region, profile: config.aws.profile });
  const client = options.s3Client ?? factory.getS3Client();
  const bucket =
    options.bucket ??
    (await resolveBucketName(
      factory,
      config.stackName || DEFAULT_STACK_NAME,
      config.aws.region,
      config.aws.profile,
    ));
  let final: FinalMessage | null = null;
  try {
    const res = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: `runs/${manifest.runId}/session.jsonl` }),
    );
    final = finalAssistantMessage((await res.Body?.transformToString()) ?? "");
  } catch (err) {
    if ((err as { name?: string }).name !== "NoSuchKey") throw err;
  }
  // VM lifecycle cannot establish assistant settlement over saved evidence of newer work.
  const state = describeResult(manifest.status, final, options.status);
  return {
    final: final ? { ...final, complete: state === "settled" } : null,
    state,
    recovery: describeRecovery(manifest, bucket),
    error: manifest.error,
  };
}
