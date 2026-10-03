import path from "node:path";
import fs from "node:fs";
import { openDb } from "./db.js";
import { RtfService, ApiError } from "./service.js";
import { startServer } from "./api/server.js";

const DATA_DIR = process.env.RTF_DATA_DIR ?? path.resolve("data");

function usage(): never {
  console.log(`用法：
  node dist/src/cli.js serve [--port N]          启动 API 服务（默认自动选择空闲端口）
  node dist/src/cli.js import <file.rtf>         导入 RTF 文件
  node dist/src/cli.js extract <documentId>      提取文本
  node dist/src/cli.js text <documentId>         输出最近提取的纯文本（UTF-8）
  node dist/src/cli.js diagnostics <documentId>  查看诊断
  node dist/src/cli.js state <documentId>        查看关键控制状态
  node dist/src/cli.js list                      列出文档
  node dist/src/cli.js export <extractionId> <txt|json> <outFile>  导出结果
环境变量：RTF_DATA_DIR 指定数据目录（默认 ./data），PORT 指定端口`);
  process.exit(1);
}

function fail(e: unknown): never {
  if (e instanceof ApiError) {
    console.error(`错误 [${e.code}] ${e.message}`);
  } else {
    console.error(`错误 ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) usage();
  const db = openDb(DATA_DIR);
  const service = new RtfService(db, DATA_DIR);

  try {
    switch (cmd) {
      case "serve": {
        let port = Number(process.env.PORT ?? 0); // 0 = 自动选择空闲端口
        const i = args.indexOf("--port");
        if (i >= 0) {
          port = Number(args[i + 1]);
          if (!Number.isInteger(port) || port < 0 || port > 65535) {
            fail(new ApiError(400, "BAD_PORT", "端口须为 0-65535 的整数"));
          }
        }
        await startServer(service, port);
        return; // 保持运行
      }
      case "import": {
        if (!args[0]) usage();
        const doc = service.importDocument(args[0]);
        console.log(JSON.stringify(doc, null, 2));
        break;
      }
      case "extract": {
        const ext = service.extract(Number(args[0]));
        console.log(JSON.stringify(ext, null, 2));
        if (ext.status !== "ok") process.exitCode = 2;
        break;
      }
      case "text": {
        const ext = service.latestExtraction(Number(args[0]));
        if (ext.status !== "ok" || ext.text === null) {
          fail(new ApiError(409, "EXTRACTION_FAILED", `提取失败：${ext.error}`));
        }
        process.stdout.write(ext.text + "\n");
        break;
      }
      case "diagnostics": {
        const ext = service.latestExtraction(Number(args[0]));
        console.log(JSON.stringify({
          status: ext.status,
          diagnostics: JSON.parse(ext.diagnostics),
          error: ext.error ? JSON.parse(ext.error) : null,
        }, null, 2));
        break;
      }
      case "state": {
        const ext = service.latestExtraction(Number(args[0]));
        console.log(ext.control_state ?? "(无，提取失败)");
        break;
      }
      case "list": {
        console.log(JSON.stringify(service.listDocuments(), null, 2));
        break;
      }
      case "export": {
        const [idStr, format, outFile] = args;
        if (!idStr || !format || !outFile) usage();
        if (format !== "txt" && format !== "json") {
          fail(new ApiError(400, "BAD_REQUEST", "格式仅支持 txt 或 json"));
        }
        const ext = service.getExtraction(Number(idStr));
        if (ext.status !== "ok" || ext.text === null) {
          fail(new ApiError(409, "EXTRACTION_FAILED", "失败的提取不可导出正文"));
        }
        const content = format === "txt"
          ? ext.text
          : JSON.stringify({
              id: ext.id, documentId: ext.document_id,
              rulesVersion: ext.rules_version, text: ext.text,
              diagnostics: JSON.parse(ext.diagnostics),
              controlState: ext.control_state ? JSON.parse(ext.control_state) : null,
            }, null, 2);
        fs.writeFileSync(path.resolve(outFile), content, "utf8");
        console.log(`已导出到 ${path.resolve(outFile)}`);
        break;
      }
      default:
        usage();
    }
  } catch (e) {
    fail(e);
  } finally {
    if (cmd !== "serve") db.close();
  }
}

main();
