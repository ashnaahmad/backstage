import http from "node:http";
import {
  CreateMicrovmAuthTokenCommand,
  LambdaMicrovmsClient,
} from "@aws-sdk/client-lambda-microvms";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROXY_PORT, RunClient, RunClientHttpError } from "../../core/client/run-client.js";
import { ProtocolHeaders, type RunManifest, type RunnerStatus } from "../../shared/protocol.js";

const microvmsMock = mockClient(LambdaMicrovmsClient);

describe("T4.5 RunClient (Tokens, HTTP, SSE, WS)", () => {
  beforeEach(() => {
    microvmsMock.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Token Management & Auto-Refresh", () => {
    it("mints proxy auth token via CreateMicrovmAuthToken and caches it", async () => {
      microvmsMock.on(CreateMicrovmAuthTokenCommand).resolves({
        authToken: {
          "X-aws-proxy-auth": "test-jwt-token-12345",
        },
      });

      const client = new RunClient({
        endpoint: "mvm-test.lambda-microvms.us-east-1.amazonaws.com",
        microvmIdentifier: "mvm-123",
        region: "us-east-1",
      });

      const token1 = await client.getAuthToken();
      expect(token1).toBe("test-jwt-token-12345");
      expect(microvmsMock.calls()).toHaveLength(1);

      // Calling again should return cached token without new AWS call
      const token2 = await client.getAuthToken();
      expect(token2).toBe("test-jwt-token-12345");
      expect(microvmsMock.calls()).toHaveLength(1);
    });

    it("auto-refreshes token at T-5 minutes before expiration", async () => {
      microvmsMock
        .on(CreateMicrovmAuthTokenCommand)
        .resolvesOnce({
          authToken: { "X-aws-proxy-auth": "token-initial" },
        })
        .resolvesOnce({
          authToken: { "X-aws-proxy-auth": "token-refreshed" },
        });

      const client = new RunClient({
        endpoint: "mvm-test.lambda-microvms.us-east-1.amazonaws.com",
        microvmIdentifier: "mvm-123",
        region: "us-east-1",
        tokenExpirationMinutes: 30,
        refreshBufferMs: 5 * 60 * 1000,
      });

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);

      const token1 = await client.getAuthToken();
      expect(token1).toBe("token-initial");

      // Advance time to 24 minutes (T-6 min to 30 min expiration -> not yet in buffer)
      vi.spyOn(Date, "now").mockReturnValue(now + 24 * 60 * 1000);
      const tokenStillValid = await client.getAuthToken();
      expect(tokenStillValid).toBe("token-initial");
      expect(microvmsMock.calls()).toHaveLength(1);

      // Advance time to 26 minutes (T-4 min to 30 min expiration -> inside 5m buffer -> should refresh)
      vi.spyOn(Date, "now").mockReturnValue(now + 26 * 60 * 1000);
      const tokenRefreshed = await client.getAuthToken();
      expect(tokenRefreshed).toBe("token-refreshed");
      expect(microvmsMock.calls()).toHaveLength(2);
    });

    it("handles forceRefresh flag to immediately mint a new token", async () => {
      microvmsMock
        .on(CreateMicrovmAuthTokenCommand)
        .resolvesOnce({
          authToken: { "X-aws-proxy-auth": "token-1" },
        })
        .resolvesOnce({
          authToken: { "X-aws-proxy-auth": "token-2" },
        });

      const client = new RunClient({
        endpoint: "mvm-test.lambda-microvms.us-east-1.amazonaws.com",
        microvmIdentifier: "mvm-123",
      });

      const t1 = await client.getAuthToken();
      expect(t1).toBe("token-1");

      const t2 = await client.getAuthToken(true);
      expect(t2).toBe("token-2");
      expect(microvmsMock.calls()).toHaveLength(2);
    });
  });

  describe("HTTP Fetch Wrapper & Error Handling", () => {
    it("attaches X-aws-proxy-auth and X-aws-proxy-port headers to requests", async () => {
      let capturedHeaders: Headers | undefined;

      const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ status: "running" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const client = new RunClient({
        endpoint: "mvm-123.lambda-microvms.us-east-1.amazonaws.com",
        token: "static-token-abc",
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const res = await client.request("/v1/status");
      expect(res.status).toBe(200);
      expect(capturedHeaders?.get(ProtocolHeaders.PROXY_AUTH)).toBe("static-token-abc");
      expect(capturedHeaders?.get(ProtocolHeaders.PROXY_PORT)).toBe(String(DEFAULT_PROXY_PORT));
    });

    it("re-mints token and retries once on HTTP 403 Forbidden", async () => {
      microvmsMock
        .on(CreateMicrovmAuthTokenCommand)
        .resolvesOnce({
          authToken: { "X-aws-proxy-auth": "expired-token" },
        })
        .resolvesOnce({
          authToken: { "X-aws-proxy-auth": "fresh-token" },
        });

      let callCount = 0;
      const receivedTokens: string[] = [];

      const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        callCount++;
        const headers = new Headers(init?.headers);
        const token = headers.get(ProtocolHeaders.PROXY_AUTH) || "";
        receivedTokens.push(token);

        if (callCount === 1) {
          return new Response(JSON.stringify({ error: "Token expired" }), { status: 403 });
        }
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const client = new RunClient({
        endpoint: "mvm-123.lambda-microvms.us-east-1.amazonaws.com",
        microvmIdentifier: "mvm-123",
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const res = await client.request("/v1/manifest");
      expect(res.status).toBe(200);
      expect(callCount).toBe(2);
      expect(receivedTokens).toEqual(["expired-token", "fresh-token"]);
      expect(microvmsMock.calls()).toHaveLength(2);
    });

    it("retries with exponential backoff on HTTP 502 (MicroVM auto-resuming)", async () => {
      let callCount = 0;

      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return new Response("Bad Gateway - MicroVM is resuming", { status: 502 });
        }
        return new Response(JSON.stringify({ status: "running" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const client = new RunClient({
        endpoint: "mvm-123.lambda-microvms.us-east-1.amazonaws.com",
        token: "test-token",
        resumeTimeoutMs: 5000,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const res = await client.request("/v1/status");
      expect(res.status).toBe(200);
      expect(callCount).toBe(3);
    });

    it("throws RunClientHttpError on unrecoverable HTTP failure", async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return new Response(
          JSON.stringify({ error: { message: "Run not found", code: "NOT_FOUND" } }),
          {
            status: 404,
            statusText: "Not Found",
            headers: { "content-type": "application/json" },
          },
        );
      });

      const client = new RunClient({
        endpoint: "localhost:8080",
        directHttp: true,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(client.getManifest()).rejects.toThrow(RunClientHttpError);
    });
  });

  describe("Typed REST Endpoints", () => {
    let mockServer: http.Server;
    let serverPort: number;

    const dummyStatus: RunnerStatus = {
      status: "idle",
      runId: "run-20260906-test01",
      uptimeSeconds: 120,
      activeConnections: 1,
      lastActivityAt: new Date().toISOString(),
      pi: { running: true },
    };

    const dummyManifest: RunManifest = {
      v: 1,
      runId: "run-20260906-test01",
      owner: "user1",
      status: "idle",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      imageVersion: "v1.0.0",
      repo: { url: "https://github.com/org/repo", workBranch: "pi-cloud/run-1" },
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      timeline: [{ status: "launching", at: new Date().toISOString() }],
    };

    beforeEach(async () => {
      mockServer = http.createServer((req, res) => {
        const url = new URL(req.url || "/", `http://${req.headers.host}`);
        if (req.method === "GET" && url.pathname === "/v1/status") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(dummyStatus));
        } else if (req.method === "GET" && url.pathname === "/v1/manifest") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(dummyManifest));
        } else if (req.method === "GET" && url.pathname === "/v1/metrics") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ tokens: { inputTokens: 100, outputTokens: 50 } }));
        } else if (req.method === "POST" && url.pathname === "/v1/prompt") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "queued", turnId: "turn-1" }));
        } else if (req.method === "POST" && url.pathname === "/v1/interrupt") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ aborted: true }));
        } else if (req.method === "POST" && url.pathname === "/v1/abort") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ aborted: true }));
        } else if (req.method === "POST" && url.pathname === "/v1/checkpoint") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "checkpointed" }));
        } else if (req.method === "POST" && url.pathname === "/v1/finalize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "finalized" }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => {
        mockServer.listen(0, "127.0.0.1", () => {
          serverPort = (mockServer.address() as { port: number }).port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it("correctly executes all REST methods against server", async () => {
      const client = new RunClient({
        endpoint: `127.0.0.1:${serverPort}`,
        directHttp: true,
      });

      const status = await client.getStatus();
      expect(status.status).toBe("idle");
      expect(status.runId).toBe("run-20260906-test01");

      const manifest = await client.getManifest();
      expect(manifest.runId).toBe("run-20260906-test01");
      expect(manifest.model.provider).toBe("anthropic");

      const metrics = await client.getMetrics();
      expect(metrics).toEqual({ tokens: { inputTokens: 100, outputTokens: 50 } });

      const promptRes = await client.prompt({ prompt: "Hello cloud" });
      expect(promptRes).toEqual({ status: "queued", turnId: "turn-1" });

      const interruptRes = await client.interrupt("User request");
      expect(interruptRes).toEqual({ aborted: true });

      const abortRes = await client.abort("Abort all");
      expect(abortRes).toEqual({ aborted: true });

      const checkpointRes = await client.checkpoint();
      expect(checkpointRes).toEqual({ status: "checkpointed" });

      const finalizeRes = await client.finalize({ autoPush: true });
      expect(finalizeRes).toEqual({ status: "finalized" });
    });
  });
});
