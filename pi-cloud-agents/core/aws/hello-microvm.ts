/**
 * Local mock of the Lambda MicroVM proxy and guest hook/runner ports.
 * Used by the Gate G3 infrastructure smoke (core/aws/infra-smoke.ts) in simulation mode.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface StepTiming {
  name: string;
  durationMs: number;
  status: "PASS" | "FAIL" | "SKIPPED";
  details?: string;
}

/**
 * Creates a lightweight local mock server simulating AWS Lambda MicroVM proxy & guest.
 */
export async function createMockMicrovmServer(options: {
  microvmId: string;
  runHookPayload: string;
  validToken: string;
}): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const proxyAuth = req.headers["x-aws-proxy-auth"];
      const proxyPort = req.headers["x-aws-proxy-port"];

      // Port 9000 isolation check: token scoped to 8080 must get 403 on port 9000
      if (proxyPort === "9000") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden: port 9000 access not authorized" }));
        return;
      }

      if (!proxyAuth || proxyAuth !== options.validToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: invalid or missing proxy token" }));
        return;
      }

      const url = req.url || "/";

      // SSE Heartbeat Endpoint
      if (url.startsWith("/sse")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "init", microvmId: options.microvmId })}\n\n`);

        let seq = 1;
        const interval = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(interval);
            return;
          }
          res.write(
            `data: ${JSON.stringify({ type: "heartbeat", seq: seq++, time: Date.now() })}\n\n`,
          );
        }, 100);

        req.on("close", () => clearInterval(interval));
        return;
      }

      // Root Status / Payload Echo Endpoint
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          message: "Hello from Lambda MicroVM (simulated)",
          microvmId: options.microvmId,
          runHookPayload: options.runHookPayload,
          payloadBytes: Buffer.byteLength(options.runHookPayload, "utf-8"),
          timestamp: Date.now(),
        }),
      );
    });

    // WebSocket handling for mock
    server.on("upgrade", (req, socket) => {
      const protoHeader = req.headers["sec-websocket-protocol"] || "";
      const isAuth = protoHeader.includes(options.validToken);
      const isPort8080 = protoHeader.includes("8080");

      if (!isAuth || !isPort8080) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const key = req.headers["sec-websocket-key"];
      const accept = crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");

      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: lambda-microvms\r\n\r\n`,
      );

      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const byte1 = buffer[0] ?? 0;
          const byte2 = buffer[1] ?? 0;
          const opcode = byte1 & 0x0f;
          const isMasked = (byte2 & 0x80) === 0x80;
          let len = byte2 & 0x7f;
          let offset = 2;

          if (len === 126) {
            if (buffer.length < 4) break;
            len = buffer.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buffer.length < 10) break;
            len = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }

          const maskLen = isMasked ? 4 : 0;
          const total = offset + maskLen + len;
          if (buffer.length < total) break;

          let payload = buffer.subarray(offset + maskLen, total);
          if (isMasked) {
            const mask = buffer.subarray(offset, offset + 4);
            const unmasked = Buffer.alloc(len);
            for (let i = 0; i < len; i++) {
              const pByte = payload[i] ?? 0;
              const mByte = mask[i % 4] ?? 0;
              unmasked[i] = pByte ^ mByte;
            }
            payload = unmasked;
          }

          buffer = buffer.subarray(total);

          if (opcode === 0x08) {
            // close
            const header = Buffer.from([0x88, 0x00]);
            socket.write(header);
            socket.end();
          } else if (opcode === 0x01 || opcode === 0x02) {
            // text or binary echo
            const header = Buffer.alloc(2);
            header[0] = 0x80 | opcode;
            header[1] = payload.length;
            socket.write(Buffer.concat([header, payload]));
          }
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
