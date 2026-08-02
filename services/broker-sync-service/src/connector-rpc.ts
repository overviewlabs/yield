import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { DomainError, type ApprovedMobileBrokerAuthorizationConnector } from "@whox/contracts";

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 32_768) throw new DomainError("CONNECTOR_REQUEST_TOO_LARGE", "Connector request is too large", 413);
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new DomainError("CONNECTOR_REQUEST_INVALID", "Connector request must be valid JSON", 400); }
}

function authorized(request: IncomingMessage, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function startConnectorRpcServer(connector: ApprovedMobileBrokerAuthorizationConnector, secret: string, port: number): Server {
  if (secret.length < 32) throw new DomainError("CONNECTOR_RPC_SECRET_INVALID", "Connector RPC authentication is unavailable", 500);
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (!authorized(request, secret)) { response.writeHead(401); response.end(JSON.stringify({ error: "unauthorized" })); return; }
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        const healthy = await connector.healthy?.() ?? true;
        response.writeHead(healthy ? 200 : 503);
        response.end(JSON.stringify({ status: healthy ? "ok" : "degraded" }));
        return;
      }
      if (request.method !== "POST") { response.writeHead(404); response.end(JSON.stringify({ error: "not_found" })); return; }
      const value = await body(request) as Record<string, unknown>;
      let result: unknown;
      if (request.url === "/authorization/start") result = await connector.beginAuthorization(value as never);
      else if (request.url === "/authorization/exchange") result = await connector.exchangeAuthorizationCode(value as never);
      else if (request.url === "/authorization/confirm") {
        await connector.confirmAuthorizationPersistence(String(value.exchangeTransactionId ?? ""), { credentialHandle: String(value.credentialHandle ?? "") } as never);
        result = { status: "confirmed" };
      } else if (request.url === "/authorization/revoke") {
        await connector.revokeAuthorization(String(value.exchangeTransactionId ?? ""));
        result = { status: "revoked" };
      } else { response.writeHead(404); response.end(JSON.stringify({ error: "not_found" })); return; }
      response.writeHead(200);
      response.end(JSON.stringify(result ?? {}));
    } catch (error) {
      const status = error instanceof DomainError ? error.httpStatus : 503;
      response.writeHead(status);
      response.end(JSON.stringify({ error: { code: error instanceof DomainError ? error.code : "CONNECTOR_UNAVAILABLE" } }));
    }
  });
  server.listen(port, "0.0.0.0");
  return server;
}
