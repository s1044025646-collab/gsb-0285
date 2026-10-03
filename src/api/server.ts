import http from "node:http";
import fs from "node:fs";
import { RtfService, ApiError } from "../service.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "BAD_JSON", "请求体不是合法 JSON");
  }
}

export function createServer(service: RtfService): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /api/documents {path}
      if (req.method === "POST" && url.pathname === "/api/documents") {
        const body = (await readBody(req)) as { path?: string };
        if (!body.path || typeof body.path !== "string") {
          throw new ApiError(400, "BAD_REQUEST", "缺少参数 path（RTF 文件路径）");
        }
        sendJson(res, 201, service.importDocument(body.path));
        return;
      }
      // GET /api/documents
      if (req.method === "GET" && url.pathname === "/api/documents") {
        sendJson(res, 200, service.listDocuments());
        return;
      }
      const docMatch = url.pathname.match(/^\/api\/documents\/(\d+)(\/.*)?$/);
      if (docMatch) {
        const id = Number(docMatch[1]);
        const sub = docMatch[2] ?? "";
        if (req.method === "GET" && sub === "") {
          sendJson(res, 200, service.getDocument(id));
          return;
        }
        if (req.method === "POST" && sub === "/extract") {
          sendJson(res, 201, service.extract(id));
          return;
        }
        if (req.method === "GET" && sub === "/extractions") {
          sendJson(res, 200, service.listExtractions(id));
          return;
        }
        if (req.method === "GET" && sub === "/extractions/latest") {
          sendJson(res, 200, service.latestExtraction(id));
          return;
        }
        if (req.method === "GET" && sub === "/text") {
          const ext = service.latestExtraction(id);
          if (ext.status !== "ok" || ext.text === null) {
            throw new ApiError(409, "EXTRACTION_FAILED",
              `最近一次提取失败：${ext.error ?? "未知错误"}`);
          }
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(ext.text);
          return;
        }
        if (req.method === "GET" && sub === "/diagnostics") {
          const ext = service.latestExtraction(id);
          sendJson(res, 200, {
            status: ext.status,
            diagnostics: JSON.parse(ext.diagnostics),
            error: ext.error ? JSON.parse(ext.error) : null,
          });
          return;
        }
        if (req.method === "GET" && sub === "/state") {
          const ext = service.latestExtraction(id);
          if (!ext.control_state) {
            throw new ApiError(409, "EXTRACTION_FAILED", "提取失败，无控制状态");
          }
          sendJson(res, 200, JSON.parse(ext.control_state));
          return;
        }
      }
      const extMatch = url.pathname.match(/^\/api\/extractions\/(\d+)(\/export)?$/);
      if (extMatch && req.method === "GET") {
        const ext = service.getExtraction(Number(extMatch[1]));
        if (extMatch[2] === "/export") {
          const format = url.searchParams.get("format") ?? "txt";
          if (ext.status !== "ok" || ext.text === null) {
            throw new ApiError(409, "EXTRACTION_FAILED", "失败的提取不可导出正文");
          }
          if (format === "txt") {
            res.writeHead(200, {
              "Content-Type": "text/plain; charset=utf-8",
              "Content-Disposition": `attachment; filename="extraction-${ext.id}.txt"`,
            });
            res.end(ext.text);
            return;
          }
          if (format === "json") {
            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Disposition": `attachment; filename="extraction-${ext.id}.json"`,
            });
            res.end(JSON.stringify({
              id: ext.id, documentId: ext.document_id,
              rulesVersion: ext.rules_version, text: ext.text,
              diagnostics: JSON.parse(ext.diagnostics),
              controlState: ext.control_state ? JSON.parse(ext.control_state) : null,
            }, null, 2));
            return;
          }
          throw new ApiError(400, "BAD_REQUEST", "format 仅支持 txt 或 json");
        }
        sendJson(res, 200, ext);
        return;
      }
      throw new ApiError(404, "NOT_FOUND", `未知路由 ${req.method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof ApiError) {
        sendJson(res, e.status, { error: { code: e.code, message: e.message } });
      } else {
        sendJson(res, 500, { error: { code: "INTERNAL", message: String(e) } });
      }
    }
    void fs;
  });
}

export async function startServer(service: RtfService, port: number): Promise<http.Server> {
  const server = createServer(service);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`RTF 提取服务已启动: http://127.0.0.1:${actual}`);
  return server;
}
