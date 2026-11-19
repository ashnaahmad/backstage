/**
 * MicroVM Run Client (T4.5).
 * Implements token minting and caching with T-5m auto-refresh,
 * and the HTTP REST wrapper with 403 refresh and 502 auto-resume backoff.
 * Runner streaming endpoints (/v1/events, /v1/rpc) are part of the runner protocol;
 * this client does not consume them.
 */

import {
  CreateMicrovmAuthTokenCommand,
  type LambdaMicrovmsClient,
} from "@aws-sdk/client-lambda-microvms";
import {
  type FinalizeRequest,
  type PromptRequest,
  ProtocolHeaders,
  type RunManifest,
  RunManifestSchema,
  type RunnerStatus,
  RunnerStatusSchema,
} from "../../shared/protocol.js";
import { AwsClientFactory } from "../aws/clients.js";

export const DEFAULT_PROXY_PORT = 8080;
export const DEFAULT_TOKEN_EXPIRATION_MINUTES = 30;
export const DEFAULT_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes (T-5 min)
export const DEFAULT_RESUME_TIMEOUT_MS = 60000; // 60 seconds

export interface RunClientOptions {
  endpoint: string;
  microvmIdentifier?: string;
  region?: string;
  profile?: string;
  microvmsClient?: LambdaMicrovmsClient;
  clientFactory?: AwsClientFactory;
  token?: string;
  directHttp?: boolean;
  tokenExpirationMinutes?: number;
  refreshBufferMs?: number;
  resumeTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class RunClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunClientError";
  }
}

export class RunClientHttpError extends RunClientError {
  readonly statusCode: number;
  readonly statusText: string;
  readonly bodyText?: string;
  readonly parsedError?: Record<string, unknown>;

  constructor(
    statusCode: number,
    statusText: string,
    bodyText?: string,
    parsedError?: Record<string, unknown>,
  ) {
    const errorMsg =
      (parsedError?.error as { message?: string })?.message ||
      (parsedError?.message as string) ||
      bodyText ||
      statusText;
    super(`HTTP ${statusCode} ${statusText}: ${errorMsg}`);
    this.name = "RunClientHttpError";
    this.statusCode = statusCode;
    this.statusText = statusText;
    this.bodyText = bodyText;
    this.parsedError = parsedError;
  }
}

/**
 * Client for interacting with an AWS Lambda MicroVM runner instance.
 */
export class RunClient {
  private readonly options: RunClientOptions;
  private readonly clientFactory: AwsClientFactory;
  private readonly fetchFn: typeof fetch;

  private cachedToken: string | null = null;
  private cachedTokenExpiresAt = 0;
  private tokenRefreshPromise: Promise<string> | null = null;

  constructor(options: RunClientOptions) {
    this.options = { ...options };
    this.clientFactory = options.clientFactory ?? new AwsClientFactory();
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);

    if (options.token) {
      this.cachedToken = options.token;
      this.cachedTokenExpiresAt =
        Date.now() +
        (options.tokenExpirationMinutes ?? DEFAULT_TOKEN_EXPIRATION_MINUTES) * 60 * 1000;
    }
  }

  /**
   * Resolves the full HTTP(S) base URL for the runner API.
   */
  public getBaseUrl(): string {
    const endpoint = this.options.endpoint.trim();
    if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
      return endpoint.replace(/\/+$/, "");
    }
    if (endpoint.startsWith("localhost") || endpoint.startsWith("127.0.0.1")) {
      return `http://${endpoint}`.replace(/\/+$/, "");
    }
    return `https://${endpoint}`.replace(/\/+$/, "");
  }

  /**
   * Retrieves or auto-refreshes the proxy auth token.
   * Auto-refreshes when within refreshBufferMs (default 5 minutes) of expiration.
   */
  public async getAuthToken(forceRefresh = false): Promise<string> {
    if (this.options.directHttp) {
      return "";
    }

    const refreshBufferMs = this.options.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS;
    const now = Date.now();

    if (!forceRefresh && this.cachedToken && now < this.cachedTokenExpiresAt - refreshBufferMs) {
      return this.cachedToken;
    }

    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = (async () => {
      try {
        const microvmId = this.options.microvmIdentifier;
        if (!microvmId) {
          if (this.cachedToken) return this.cachedToken;
          throw new RunClientError("microvmIdentifier is required to mint proxy auth tokens");
        }

        const microvmsClient =
          this.options.microvmsClient ??
          this.clientFactory.getLambdaMicrovmsClient({
            region: this.options.region,
            profile: this.options.profile,
          });

        const expirationMinutes =
          this.options.tokenExpirationMinutes ?? DEFAULT_TOKEN_EXPIRATION_MINUTES;
        const res = await microvmsClient.send(
          new CreateMicrovmAuthTokenCommand({
            microvmIdentifier: microvmId,
            expirationInMinutes: expirationMinutes,
            allowedPorts: [{ port: DEFAULT_PROXY_PORT }],
          }),
        );

        const tokenMap = res.authToken ?? {};
        const proxyToken =
          tokenMap["X-aws-proxy-auth"] ||
          tokenMap["x-aws-proxy-auth"] ||
          Object.values(tokenMap)[0];

        if (!proxyToken) {
          throw new RunClientError(
            "Failed to extract X-aws-proxy-auth from CreateMicrovmAuthToken response",
          );
        }

        this.cachedToken = proxyToken;
        this.cachedTokenExpiresAt = Date.now() + expirationMinutes * 60 * 1000;
        return proxyToken;
      } finally {
        this.tokenRefreshPromise = null;
      }
    })();

    return this.tokenRefreshPromise;
  }

  /**
   * Performs an HTTP request against the runner API with proxy headers,
   * 403 token auto-refresh, and 502 auto-resume exponential backoff.
   */
  public async request(path: string, init: RequestInit = {}): Promise<Response> {
    const baseUrl = this.getBaseUrl();
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${baseUrl}${cleanPath}`;
    const resumeTimeoutMs = this.options.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS;
    const startTime = Date.now();

    let attempt = 0;
    let retried403 = false;

    while (true) {
      const token = await this.getAuthToken();
      const headers = new Headers(init.headers);

      if (token) {
        headers.set(ProtocolHeaders.PROXY_AUTH, token);
      }
      headers.set(ProtocolHeaders.PROXY_PORT, String(DEFAULT_PROXY_PORT));

      if (init.body && !headers.has("content-type") && typeof init.body === "string") {
        headers.set("content-type", "application/json");
      }

      try {
        const res = await this.fetchFn(url, {
          ...init,
          headers,
        });

        // 1. Handle 403 Forbidden -> Token expired or invalid, re-mint once and retry
        if (
          res.status === 403 &&
          !retried403 &&
          !this.options.directHttp &&
          this.options.microvmIdentifier
        ) {
          retried403 = true;
          await this.getAuthToken(true);
          continue;
        }

        // 2. Handle 502 Bad Gateway -> MicroVM is auto-resuming from SUSPENDED (ADR-4)
        if (res.status === 502) {
          const elapsed = Date.now() - startTime;
          if (elapsed < resumeTimeoutMs) {
            attempt++;
            const baseDelay = Math.min(500 * 1.5 ** attempt, 4000);
            const jitter = (Math.random() * 0.4 - 0.2) * baseDelay;
            const delay = Math.max(100, Math.round(baseDelay + jitter));
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(delay, resumeTimeoutMs - elapsed)),
            );
            continue;
          }
        }

        return res;
      } catch (err: unknown) {
        // Network errors during resume may happen before proxy responds
        const elapsed = Date.now() - startTime;
        if (elapsed < resumeTimeoutMs) {
          attempt++;
          const baseDelay = Math.min(500 * 1.5 ** attempt, 4000);
          const delay = Math.max(100, Math.round(baseDelay));
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(delay, resumeTimeoutMs - elapsed)),
          );
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Performs an HTTP request and parses JSON body, throwing RunClientHttpError on non-2xx status.
   */
  public async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON
    }

    if (!res.ok) {
      throw new RunClientHttpError(
        res.status,
        res.statusText,
        text,
        json && typeof json === "object" ? (json as Record<string, unknown>) : undefined,
      );
    }

    return json as T;
  }

  /**
   * Retrieves runner status from GET /v1/status.
   */
  public async getStatus(): Promise<RunnerStatus> {
    const json = await this.requestJson<unknown>("/v1/status");
    return RunnerStatusSchema.parse(json);
  }

  /**
   * Retrieves current run manifest from GET /v1/manifest.
   */
  public async getManifest(): Promise<RunManifest> {
    const json = await this.requestJson<unknown>("/v1/manifest");
    return RunManifestSchema.parse(json);
  }

  /**
   * Retrieves runner metrics from GET /v1/metrics.
   */
  public async getMetrics(): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>("/v1/metrics");
  }

  /**
   * Sends user prompt, steer, or follow-up to POST /v1/prompt.
   */
  public async prompt(req: PromptRequest): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>("/v1/prompt", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  /**
   * Sends interrupt signal to POST /v1/interrupt.
   */
  public async interrupt(reason?: string): Promise<{ aborted: boolean }> {
    return this.requestJson<{ aborted: boolean }>("/v1/interrupt", {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  /**
   * Sends abort signal to POST /v1/abort.
   */
  public async abort(reason?: string): Promise<{ aborted: boolean }> {
    return this.requestJson<{ aborted: boolean }>("/v1/abort", {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  /**
   * Triggers session checkpoint on POST /v1/checkpoint.
   */
  public async checkpoint(): Promise<{ status: string }> {
    return this.requestJson<{ status: string }>("/v1/checkpoint", {
      method: "POST",
    });
  }

  /**
   * Finalizes the run on POST /v1/finalize.
   */
  public async finalize(req?: FinalizeRequest): Promise<{ status: string }> {
    return this.requestJson<{ status: string }>("/v1/finalize", {
      method: "POST",
      body: JSON.stringify(req ?? {}),
    });
  }

  /**
   * Shuts down the runner on POST /v1/shutdown.
   */
  public async shutdown(): Promise<{ status: string }> {
    return this.requestJson<{ status: string }>("/v1/shutdown", {
      method: "POST",
    });
  }
}
