import fs from "node:fs";
import path from "node:path";
import { Store } from "./app/db";
import { RtfService, ApiError } from "./app/service";
import { createServer } from "./app/http";

const DATA_DIR = process.env.RTF_DATA_DIR ?? "data";

function usage(): never {
  console.log(`用法: node dist/src/cli.js <命令> [参数]

命令:
  import <file.rtf>          导入 RTF 文件（复制只读副本到数据目录）
  extract <documentId>       提取文本并输出 UTF-8 结果与诊断
  diag <documentId>          查询最近一次提取的诊断
  state <documentId>         查询关键控制状态（uc/代码页/跳过目的地等）
  history <documentId>       查看提取历史
  export <extractionId> <txt|json>   导出结果到 data/exports
  list                       列出已导入文档
  serve [--port N]           启动 HTTP API（默认自动选择空闲端口）
  demo                       端到端演示（构造样例 -> 导入 -> 提取 -> 导出）
`);
  process.exit(1);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) usage();
  const service = new RtfService(new Store(DATA_DIR));
  try {
    switch (cmd) {
      case "import": {
        if (!args[0]) usage();
        const doc = service.importFile(args[0]);
        console.log(JSON.stringify(doc, null, 2));
        break;
      }
      case "extract": {
        const id = Number(args[0]);
        if (!Number.isInteger(id)) usage();
        const ex = service.extract(id);
        console.log(`status: ${ex.status}`);
        console.log("--- 文本 (UTF-8) ---");
        console.log(ex.text ?? "(失败，无文本)");
        console.log("--- 诊断 ---");
        console.log(JSON.stringify(ex.diagnostics, null, 2));
        break;
      }
      case "diag": {
        console.log(JSON.stringify(service.latest(Number(args[0])).diagnostics, null, 2));
        break;
      }
      case "state": {
        console.log(JSON.stringify(service.latest(Number(args[0])).state, null, 2));
        break;
      }
      case "history": {
        const rows = service.store.listExtractions(Number(args[0]));
        console.log(JSON.stringify(rows.map((r) => service.getExtraction(r.id)), null, 2));
        break;
      }
      case "export": {
        const id = Number(args[0]);
        const format = args[1];
        if (format !== "txt" && format !== "json") usage();
        const r = service.export(id, format);
        console.log(`已导出: ${r.path}`);
        break;
      }
      case "list": {
        console.log(JSON.stringify(service.store.listDocuments(), null, 2));
        break;
      }
      case "serve": {
        const pi = args.indexOf("--port");
        const port = pi >= 0 ? Number(args[pi + 1]) : 0;
        const server = createServer(service);
        server.listen(port, "127.0.0.1", () => {
          const addr = server.address();
          console.log(`服务已启动: http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
        });
        return; // 不关闭 store
      }
      case "demo": {
        const sample = path.join("samples", "demo.rtf");
        fs.mkdirSync("samples", { recursive: true });
        const rtf =
          "{\\rtf1\\ansi\\ansicpg1252\\uc1\n" +
          "{\\fonttbl{\\f0 Arial;}}\n" +
          "{\\colortbl;\\red255\\green0\\blue0;}\n" +
          "{\\info{\\title Demo}}\n" +
          "{\\*\\unknown dest ignored}\n" +
          "Hello \\'e9 World!\\par\n" +
          "{\\b Bold}\\i0 plain\\par\n" +
          "\\u20013?\\u25991?\\par\n" +
          "\\u55357\\u56834?\\par\n" +
          "{\\uc2\\u9312??} after\\par\n" +
          "}";
        fs.writeFileSync(sample, Buffer.from(rtf, "latin1"));
        const doc = service.importFile(sample);
        console.log(`导入文档 id=${doc.id} sha256=${doc.sha256}`);
        const ex = service.extract(doc.id);
        console.log(`status: ${ex.status}`);
        console.log("--- 文本 (UTF-8) ---");
        process.stdout.write((ex.text ?? "") + "\n");
        console.log("--- 诊断 ---");
        console.log(JSON.stringify(ex.diagnostics, null, 2));
        const out = service.export(ex.id, "txt");
        console.log(`已导出: ${out.path}`);
        break;
      }
      default:
        usage();
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      process.exit(2);
    }
    throw err;
  } finally {
    if (cmd !== "serve") service.store.close();
  }
}

main();
