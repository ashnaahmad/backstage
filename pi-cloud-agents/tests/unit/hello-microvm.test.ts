/**
 * Unit tests for the deterministic ZIP builder used by image/scheduled builds and the local
 * MicroVM proxy mock used by the infrastructure smoke simulation.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMockMicrovmServer } from "../../core/aws/hello-microvm.js";
import { computeCrc32, createDeterministicZip } from "../../core/aws/zip.js";

describe("Deterministic ZIP Builder", () => {
  it("computes accurate CRC32 checksums", () => {
    const testData = Buffer.from("123456789", "utf-8");
    // Standard CRC32 check value for "123456789" is 0xcbf43926 (3421780262)
    const crc = computeCrc32(testData);
    expect(crc).toBe(0xcbf43926);
  });

  it("produces deterministic, byte-for-byte identical output for identical inputs", () => {
    const entries = [
      { name: "b.txt", content: "hello world" },
      { name: "a.txt", content: "alpha beta" },
    ];

    const zip1 = createDeterministicZip(entries);
    const zip2 = createDeterministicZip(entries);

    expect(zip1.length).toBeGreaterThan(0);
    expect(zip1.equals(zip2)).toBe(true);

    const hash1 = createHash("sha256").update(zip1).digest("hex");
    const hash2 = createHash("sha256").update(zip2).digest("hex");
    expect(hash1).toBe(hash2);
  });

  it("includes valid PKZIP signatures", () => {
    const zip = createDeterministicZip([{ name: "test.txt", content: "sample" }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50); // Local header signature
  });
});

describe("Mock MicroVM Server & Protocol Validation", () => {
  it("enforces authentication and port isolation rules", async () => {
    const validToken = "test-auth-token-12345";
    const server = await createMockMicrovmServer({
      microvmId: "mvm-test-1",
      runHookPayload: JSON.stringify({ hello: "world" }),
      validToken,
    });

    try {
      const port = server.port;

      // 1. Missing token -> 401
      const resUnauth = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { "X-aws-proxy-port": "8080" },
      });
      expect(resUnauth.status).toBe(401);

      // 2. Port 9000 isolation -> 403 Forbidden
      const resPort9000 = await fetch(`http://127.0.0.1:${port}/`, {
        headers: {
          "X-aws-proxy-auth": validToken,
          "X-aws-proxy-port": "9000",
        },
      });
      expect(resPort9000.status).toBe(403);

      // 3. Valid port 8080 + auth -> 200 OK
      const resOk = await fetch(`http://127.0.0.1:${port}/`, {
        headers: {
          "X-aws-proxy-auth": validToken,
          "X-aws-proxy-port": "8080",
        },
      });
      expect(resOk.status).toBe(200);
      const json = (await resOk.json()) as Record<string, unknown>;
      expect(json.status).toBe("ok");
      expect(json.microvmId).toBe("mvm-test-1");
    } finally {
      await server.close();
    }
  });
});
