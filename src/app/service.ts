import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseRtf, RULES_VERSION, ParseResult } from "../rtf/parser";
import { RtfError, Diagnostic } from "../rtf/errors";
import { Store, ExtractionRow } from "./db";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(`[${code}] ${message}`);
  }
}

export interface ExtractionView {
  id: number;
  documentId: number;
  rulesVersion: string;
  status: string;
  text: string | null;
  diagnostics: Diagnostic[];
  state: unknown;
  createdAt: string;
}

function toView(row: ExtractionRow): ExtractionView {
  return {
    id: row.id,
    documentId: row.document_id,
    rulesVersion: row.rules_version,
    status: row.status,
    text: row.text,
    diagnostics: JSON.parse(row.diagnostics),
    state: row.state ? JSON.parse(row.state) : null,
    createdAt: row.created_at,
  };
}

export class RtfService {
  constructor(public store: Store) {}

  importFile(sourcePath: string) {
    const abs = path.resolve(sourcePath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new ApiError(400, "E_FILE_NOT_FOUND", `文件不存在: ${abs}`);
    }
    const buf = fs.readFileSync(abs); // 按原始字节读取，不做任何编码猜测
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const storedName = `${sha256.slice(0, 16)}_${path.basename(abs)}`;
    const storedPath = path.join(this.store.filesDir, storedName);
    if (fs.existsSync(storedPath)) fs.chmodSync(storedPath, 0o644);
    fs.copyFileSync(abs, storedPath); // 只读副本，源文件不被修改
    fs.chmodSync(storedPath, 0o444);
    const id = this.store.insertDocument({
      name: path.basename(abs),
      sha256,
      size: buf.length,
      source_path: abs,
      stored_path: storedPath,
      imported_at: new Date().toISOString(),
    });
    return this.store.getDocument(id)!;
  }

  extract(documentId: number): ExtractionView {
    const doc = this.store.getDocument(documentId);
    if (!doc) throw new ApiError(404, "E_DOC_NOT_FOUND", `文档 ${documentId} 不存在`);
    const buf = fs.readFileSync(doc.stored_path);
    let status = "ok";
    let text: string | null = null;
    let diagnostics: Diagnostic[] = [];
    let state: unknown = null;
    try {
      const result: ParseResult = parseRtf(buf);
      text = result.text;
      diagnostics = result.diagnostics;
      state = result.state;
      if (diagnostics.some((d) => d.severity === "warning")) status = "ok_with_warnings";
    } catch (err) {
      if (err instanceof RtfError) {
        status = "failed";
        diagnostics = [
          { severity: "error", code: err.code, message: err.message, offset: err.offset },
        ];
      } else {
        throw err;
      }
    }
    const id = this.store.insertExtraction({
      document_id: documentId,
      rules_version: RULES_VERSION,
      status,
      text,
      diagnostics: JSON.stringify(diagnostics),
      state: state ? JSON.stringify(state) : null,
      created_at: new Date().toISOString(),
    });
    return toView(this.store.getExtraction(id)!);
  }

  getExtraction(id: number): ExtractionView {
    const row = this.store.getExtraction(id);
    if (!row) throw new ApiError(404, "E_EXTRACTION_NOT_FOUND", `提取记录 ${id} 不存在`);
    return toView(row);
  }

  latest(documentId: number): ExtractionView {
    const row = this.store.latestExtraction(documentId);
    if (!row) throw new ApiError(404, "E_NO_EXTRACTION", `文档 ${documentId} 尚未提取`);
    return toView(row);
  }

  export(extractionId: number, format: "txt" | "json"): { path: string; content: string } {
    const ex = this.getExtraction(extractionId);
    if (ex.status === "failed" || ex.text === null) {
      throw new ApiError(409, "E_EXTRACTION_FAILED", "失败的提取不能导出正文");
    }
    const content =
      format === "txt"
        ? ex.text
        : JSON.stringify(ex, null, 2);
    const file = path.join(this.store.exportsDir, `extraction_${extractionId}.${format}`);
    fs.writeFileSync(file, content, "utf8"); // 始终写 UTF-8
    return { path: file, content };
  }
}
