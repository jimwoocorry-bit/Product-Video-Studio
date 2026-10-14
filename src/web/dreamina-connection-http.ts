import type { IncomingMessage, ServerResponse } from "node:http";
import type { DreaminaConnectionService } from "../application/services/dreamina-connection-service.js";
import { renderDreaminaConnectionPage } from "./dreamina-connection-ui.js";

export async function handleDreaminaConnectionHttp(req: IncomingMessage, res: ServerResponse, url: URL,
  deps: { dreaminaConnection?: DreaminaConnectionService }): Promise<boolean> {
  const page = url.pathname === "/settings/dreamina";
  const api = ["/api/dreamina/connection", "/api/dreamina/connection/login", "/api/dreamina/connection/confirm"].includes(url.pathname);
  if (!page && !api) return false;
  res.setHeader("cache-control", "no-store");
  const json = (code: number, value: unknown) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
  if (!deps.dreaminaConnection) { json(503, { message: "即梦连接服务尚未配置。" }); return true; }
  if (req.method === "GET" && page) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDreaminaConnectionPage(await deps.dreaminaConnection.status())); return true;
  }
  if (req.method === "GET" && url.pathname === "/api/dreamina/connection") {
    json(200, await deps.dreaminaConnection.status()); return true;
  }
  if (req.method === "POST" && !page && url.pathname !== "/api/dreamina/connection") {
    const origin = req.headers.origin;
    if (req.headers["sec-fetch-site"] === "cross-site" || (origin && (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })())) {
      json(403, { message: "请从本实例的即梦连接页面操作。" }); return true;
    }
    // No executable, shell command, authorization token or device reference can be supplied by the client.
    const state = url.pathname.endsWith("/login") ? await deps.dreaminaConnection.begin() : await deps.dreaminaConnection.confirm();
    json(200, state); return true;
  }
  res.setHeader("allow", page ? "GET" : url.pathname.endsWith("/connection") ? "GET" : "POST");
  json(405, { message: "请求方法不支持。" }); return true;
}
