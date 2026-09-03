import http from "node:http";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ChromeController } from "../controller.js";
import { createMcpServer } from "./server.js";

export interface HttpServerSecurityOptions {
  authToken?: string;
  allowInsecureNoAuth?: boolean;
  enableCors?: boolean;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  maxBodySizeBytes?: number;
}

const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB limit

/**
 * Constant-time string comparison to prevent timing attacks on token validation
 */
function safeTokenCompare(provided: string, expected: string): boolean {
  try {
    const bufProvided = Buffer.from(provided, "utf8");
    const bufExpected = Buffer.from(expected, "utf8");
    if (bufProvided.length !== bufExpected.length) {
      return false;
    }
    return timingSafeEqual(bufProvided, bufExpected);
  } catch {
    return false;
  }
}

export function extractHostname(rawHost: string): string {
  const trimmed = rawHost.trim();
  if (!trimmed) return "";

  // 1. Bracketed IPv6 format: e.g. "[::1]:8080", "[::1]", "[fe80::1]:3000", "[2001:db8::1]"
  if (trimmed.startsWith("[")) {
    const closingBracket = trimmed.indexOf("]");
    if (closingBracket !== -1) {
      return trimmed.slice(1, closingBracket).toLowerCase();
    }
  }

  // 2. IPv4 or domain name with optional port: e.g. "127.0.0.1:8080", "localhost:3000", "example.com:90"
  const colons = trimmed.split(":");
  if (colons.length === 2) {
    // Single colon means host:port
    return colons[0].toLowerCase();
  }

  // Multiple colons (unbracketed raw IPv6 e.g. "::1", "fe80::1") or no colon ("localhost", "127.0.0.1")
  return trimmed.toLowerCase();
}

export async function runHttpMcpServer(
  port = Number(process.env.MCP_HTTP_PORT || 8765),
  host = process.env.MCP_HTTP_HOST || "127.0.0.1",
  controllerInstance?: ChromeController,
  securityOptions: HttpServerSecurityOptions = {}
): Promise<{
  server: http.Server;
  transports: Record<string, StreamableHTTPServerTransport>;
  controller: ChromeController;
  authToken: string;
}> {
  // 1. Mandatory Auth Enforcement
  let authToken = securityOptions.authToken || process.env.MCP_AUTH_TOKEN;
  if (!authToken) {
    if (securityOptions.allowInsecureNoAuth || process.env.MCP_ALLOW_INSECURE_NO_AUTH === "true") {
      // Insecure mode is loopback-dev only. Refuse on public binds.
      const insecureHost = extractHostname(host);
      const insecureLoopback =
        insecureHost === "127.0.0.1" ||
        insecureHost === "localhost" ||
        insecureHost === "::1" ||
        insecureHost === "::ffff:127.0.0.1";
      if (!insecureLoopback) {
        throw new Error("MCP_ALLOW_INSECURE_NO_AUTH is only permitted on loopback hosts (127.0.0.1/localhost/::1)");
      }
      console.warn("[MCP-HTTP] Warning: Server running in insecure mode without authentication.");
    } else {
      authToken = randomBytes(32).toString("hex");
      const fingerprint = authToken.slice(0, 8);
      console.log(`[MCP-HTTP] Generated mandatory authentication token (fingerprint ${fingerprint}…). Set MCP_AUTH_TOKEN to persist it.`);
    }
  }

  // 2. Loopback Enforcement & Host validation list
  // NOTE: "::" is NOT loopback (unspecified address). It must not grant trust.
  const normalizedHost = extractHostname(host);
  const isLoopback =
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "localhost" ||
    normalizedHost === "::1" ||
    normalizedHost === "::ffff:127.0.0.1";
  if (!isLoopback) {
    console.warn(`[MCP-HTTP] Security Warning: Binding to non-loopback host (${host}). Ensure firewall rules are applied.`);
  }

  const allowedHostsSet = new Set<string>([
    "127.0.0.1",
    "localhost",
    "::1",
    "[::1]",
    "::",
    "[::]",
    normalizedHost,
    `[${normalizedHost}]`,
    ...(securityOptions.allowedHosts || []).map((h) => extractHostname(h)),
    ...(process.env.MCP_ALLOWED_HOSTS ? process.env.MCP_ALLOWED_HOSTS.split(",").map((h) => extractHostname(h.trim())) : []),
  ]);

  // 3. CORS Configuration
  const enableCors =
    securityOptions.enableCors ?? (process.env.MCP_ENABLE_CORS === "true");
  const allowedOriginsSet = new Set<string>([
    ...(securityOptions.allowedOrigins || []),
    ...(process.env.MCP_ALLOWED_ORIGINS ? process.env.MCP_ALLOWED_ORIGINS.split(",").map((o) => o.trim()) : []),
  ]);

  // 4. Request Limit
  const envMaxBodySize = process.env.MCP_MAX_BODY_SIZE
    ? parseInt(process.env.MCP_MAX_BODY_SIZE, 10)
    : undefined;
  const maxBodySizeBytes =
    securityOptions.maxBodySizeBytes ||
    (envMaxBodySize && !isNaN(envMaxBodySize) ? envMaxBodySize : DEFAULT_MAX_BODY_SIZE);

  const mode = (process.env.CHROME_CONNECT_MODE as any) || "auto";
  const controller =
    controllerInstance ||
    new ChromeController({
      mode,
      browserUrl: process.env.CHROME_BROWSER_URL,
      wsEndpoint: process.env.CHROME_WS_ENDPOINT,
    });

  if (!controllerInstance) {
    try {
      await controller.connect();
    } catch (err: any) {
      console.error(`[MCP-HTTP] Warning: initial connection failed: ${err.message}. Ready for auto-reconnect.`);
    }
  }

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const server = http.createServer(async (req, res) => {
    // -------------------------------------------------------------------------
    // A. Host Header Validation (DNS Rebinding Protection)
    // -------------------------------------------------------------------------
    const rawHostHeader = req.headers["host"] || "";
    const hostname = extractHostname(rawHostHeader);

    if (!hostname || (!allowedHostsSet.has(hostname) && !allowedHostsSet.has(`[${hostname}]`))) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden: Invalid or unrecognized Host header" }));
      return;
    }

    // -------------------------------------------------------------------------
    // B. CORS Enforcement (Disabled by default)
    // -------------------------------------------------------------------------
    const origin = req.headers["origin"] as string | undefined;
    let originAllowed = false;

    if (enableCors && origin) {
      // "*" is never honored when Authorization is in use — it would let any
      // website drive the browser with a stolen token. Require explicit origins.
      if (allowedOriginsSet.has("*")) {
        console.warn("[MCP-HTTP] Ignoring MCP_ALLOWED_ORIGINS=* while authentication is enabled. Configure explicit origins.");
      } else if (allowedOriginsSet.has(origin)) {
        originAllowed = true;
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
        res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
      }
    }

    if (req.method === "OPTIONS") {
      if (enableCors && originAllowed) {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "CORS not allowed for this origin" }));
      }
      return;
    }

    // -------------------------------------------------------------------------
    // C. Mandatory Authentication Check
    // -------------------------------------------------------------------------
    if (authToken) {
      const authHeader = req.headers["authorization"] || "";
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      const providedToken = match ? match[1] : "";

      if (!providedToken || !safeTokenCompare(providedToken, authToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing Bearer token" }));
        return;
      }
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", connected: controller.isConnected }));
      return;
    }

    if (url.pathname === "/doctor") {
      const doc = await controller.doctor();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(doc, null, 2));
      return;
    }

    // -------------------------------------------------------------------------
    // D. Official Streamable HTTP Handling with Request Limits
    // -------------------------------------------------------------------------
    if (url.pathname === "/mcp" || url.pathname === "/" || url.pathname.startsWith("/mcp/")) {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "GET") {
        if (sessionId && transports[sessionId]) {
          await transports[sessionId].handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing session ID for SSE connection" }));
        return;
      }

      if (req.method === "DELETE") {
        if (sessionId && transports[sessionId]) {
          await transports[sessionId].handleRequest(req, res);
          delete transports[sessionId];
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing session ID for termination" }));
        return;
      }

      if (req.method === "POST") {
        const contentLengthHeader = req.headers["content-length"];
        if (contentLengthHeader) {
          const contentLength = parseInt(contentLengthHeader, 10);
          if (!isNaN(contentLength) && contentLength > maxBodySizeBytes) {
            res.writeHead(413, {
              "Content-Type": "application/json",
              "Connection": "close",
            });
            res.end(JSON.stringify({ error: "Payload Too Large: Request body exceeds maximum allowed size" }));
            req.resume();
            return;
          }
        }

        let body = "";
        let bodySize = 0;
        let limitExceeded = false;

        req.on("data", (chunk) => {
          if (limitExceeded) return;
          bodySize += chunk.length;

          if (bodySize > maxBodySizeBytes) {
            limitExceeded = true;
            res.writeHead(413, {
              "Content-Type": "application/json",
              "Connection": "close",
            });
            res.end(JSON.stringify({ error: "Payload Too Large: Request body exceeds maximum allowed size" }));
            req.resume();
            return;
          }
          body += chunk;
        });

        req.on("end", async () => {
          if (limitExceeded) return;

          try {
            let parsedBody: any = undefined;
            if (body) {
              try {
                parsedBody = JSON.parse(body);
              } catch {}
            }

            if (sessionId && transports[sessionId]) {
              await transports[sessionId].handleRequest(req, res, parsedBody);
              return;
            }

            if (!sessionId && isInitializeRequest(parsedBody)) {
              const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                  transports[sid] = transport;
                },
              });

              transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                  delete transports[sid];
                }
              };

              const mcpServer = await createMcpServer(controller);
              await mcpServer.connect(transport);
              await transport.handleRequest(req, res, parsedBody);
              return;
            }

            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "Bad Request: No valid session ID provided or not an initialize request",
                },
                id: null,
              })
            );
          } catch (err: any) {
            console.error("[MCP-HTTP] Request failed:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
              res.end(JSON.stringify({ error: "Internal error" }));
            }
          }
        });
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[MCP-HTTP] Hardened Streamable HTTP server listening on http://${host}:${actualPort}/mcp`);
      resolve();
    });
    server.on("error", reject);
  });

  return { server, transports, controller, authToken: authToken || "" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHttpMcpServer().catch((err) => {
    console.error("Fatal MCP HTTP server error:", err);
    process.exit(1);
  });
}
