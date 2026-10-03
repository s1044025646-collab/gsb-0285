import http from "node:http";
import { RtfService, ApiError } from "./service";

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "E_BAD_JSON", "请求体不是合法 JSON");
  }
}

export function createServer(service: RtfService): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body, null, 2);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(payload);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return send(200, { ok: true });
      }
      if (method === "POST" && url.pathname === "/documents") {
        const body = await readBody(req);
        if (typeof body.path !== "string" || !body.path) {
          throw new ApiError(400, "E_BAD_PARAM", "缺少参数 path（RTF 文件路径）");
        }
        return send(201, service.importFile(body.path));
      }
      if (method === "GET" && url.pathname === "/documents") {
        return send(200, service.store.listDocuments());
      }
      const docMatch = url.pathname.match(/^\/documents\/(\d+)(\/(extract|extractions|diagnostics|state))?$/);
      if (docMatch) {
        const id = Number(docMatch[1]);
        const sub = docMatch[3];
        if (!sub && method === "GET") {
          const doc = service.store.getDocument(id);
          if (!doc) throw new ApiError(404, "E_DOC_NOT_FOUND", `文档 ${id} 不存在`);
          return send(200, doc);
        }
        if (sub === "extract" && method === "POST") return send(201, service.extract(id));
        if (sub === "extractions" && method === "GET") {
          return send(200, service.store.listExtractions(id).map((r) => service.getExtraction(r.id)));
        }
        if (sub === "diagnostics" && method === "GET") return send(200, service.latest(id).diagnostics);
        if (sub === "state" && method === "GET") return send(200, service.latest(id).state);
      }
      const exMatch = url.pathname.match(/^\/extractions\/(\d+)(\/export)?$/);
      if (exMatch) {
        const id = Number(exMatch[1]);
        if (!exMatch[2] && method === "GET") return send(200, service.getExtraction(id));
        if (exMatch[2] && method === "GET") {
          const format = url.searchParams.get("format") ?? "txt";
          if (format !== "txt" && format !== "json") {
            throw new ApiError(400, "E_BAD_PARAM", "format 仅支持 txt 或 json");
          }
          return send(200, service.export(id, format));
        }
      }
      throw new ApiError(404, "E_NOT_FOUND", `未知路由: ${method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof ApiError) {
        return send(err.status, { error: { code: err.code, message: err.message } });
      }
      return send(500, { error: { code: "E_INTERNAL", message: String(err) } });
    }
  });
}
