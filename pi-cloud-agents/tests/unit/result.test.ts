import { describe, expect, it } from "vitest";
import { describeRecovery, describeResult, finalAssistantMessage } from "../../core/result.js";

const answer = {
  type: "message",
  message: {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "First answer" }],
  },
};

describe("durable assignment result semantics", () => {
  it("labels earlier or failed preservation honestly rather than calling an old bundle current", () => {
    const recovery = {
      key: "runs/run-test/artifacts/old.bundle",
      commit: "a".repeat(40),
      sha256: "b".repeat(64),
    };
    expect(
      describeRecovery(
        { git: { workBranch: "work", lastCommit: "c".repeat(40), recovery } },
        "bucket",
      ),
    ).toMatchObject({ commit: recovery.commit, current: false });
    expect(
      describeRecovery(
        {
          git: { workBranch: "work", lastCommit: recovery.commit, recovery },
          error: {
            code: "INTERNAL_ERROR",
            message: "dirty files could not be committed",
            details: { stage: "git_preservation" },
          },
        },
        "bucket",
      )?.current,
    ).toBe(false);
  });
  it("does not present an older answer as complete after a new user message", () => {
    const session = [
      answer,
      { type: "message", message: { role: "user", content: "Next assignment" } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    expect(finalAssistantMessage(session)).toMatchObject({ text: "First answer", complete: false });
    expect(describeResult("idle", finalAssistantMessage(session))).toBe("pending");
  });
  it.each(["error", "aborted", "toolUse", "pending"])(
    "never calls a %s response a settled result, even after termination",
    (stopReason) => {
      const final = finalAssistantMessage(
        JSON.stringify({ ...answer, message: { ...answer.message, stopReason } }),
      );
      expect(describeResult("terminated", final)).toBe("incomplete");
    },
  );
  it.each(["terminated", "failed"])(
    "a %s VM cannot promote an old answer over saved running evidence",
    (lifecycle) => {
      const previous = finalAssistantMessage(JSON.stringify(answer));
      expect(describeResult("running", previous, lifecycle)).toBe("incomplete");
      expect(previous?.text).toBe("First answer");
      expect(describeResult("idle", previous, lifecycle)).toBe("settled");
    },
  );

  it("reports terminal lifecycle separately from the durable assistant answer", () => {
    const final = finalAssistantMessage(JSON.stringify(answer));
    expect(describeResult("running", final)).toBe("pending");
    expect(describeResult("idle", final)).toBe("settled");
    expect(describeResult("terminated", final)).toBe("settled");
    expect(describeResult("terminated", null)).toBe("incomplete");
  });
});
