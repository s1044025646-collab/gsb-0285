import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { extractRtf, RtfError, RULES_VERSION } from "./rtf/parser.js";
import type { DocumentRow, ExtractionRow } from "./db.js";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class RtfService {
  constructor(private db: DatabaseSync, private dataDir: string) {}

  importDocument(sourcePath: string): DocumentRow {
    const abs = path.resolve(sourcePath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new ApiError(400, "FILE_NOT_FOUND", `文件不存在：${abs}`);
    }
    const buf = fs.readFileSync(abs);
    if (buf.length === 0) {
      throw new ApiError(400, "EMPTY_FILE", "文件为空");
    }
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const copyPath = path.join(this.dataDir, "files", `${sha}.rtf`);
    if (!fs.existsSync(copyPath)) {
      fs.writeFileSync(copyPath, buf); // 只读副本，源文件不改动
    }
    const stmt = this.db.prepare(
      `INSERT INTO documents (name, sha256, source_path, copy_path, size, imported_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const res = stmt.run(
      path.basename(abs), sha, abs, copyPath, buf.length, new Date().toISOString()
    );
    return this.getDocument(Number(res.lastInsertRowid));
  }

  getDocument(id: number): DocumentRow {
    const row = this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as
      | DocumentRow | undefined;
    if (!row) throw new ApiError(404, "NOT_FOUND", `文档 ${id} 不存在`);
    return row;
  }

  listDocuments(): DocumentRow[] {
    return this.db.prepare(`SELECT * FROM documents ORDER BY id`).all() as unknown as DocumentRow[];
  }

  extract(documentId: number): ExtractionRow {
    const doc = this.getDocument(documentId);
    const buf = fs.readFileSync(doc.copy_path);
    let status = "ok";
    let text: string | null = null;
    let diagnostics: unknown[] = [];
    let controlState: string | null = null;
    let error: string | null = null;
    try {
      const result = extractRtf(buf);
      text = result.text;
      diagnostics = result.diagnostics;
      controlState = JSON.stringify(result.controlState);
    } catch (e) {
      status = "failed";
      if (e instanceof RtfError) {
        error = JSON.stringify({ code: e.code, message: e.message, offset: e.offset ?? null });
      } else {
        error = JSON.stringify({ code: "INTERNAL", message: String(e) });
      }
    }
    const res = this.db.prepare(
      `INSERT INTO extractions
        (document_id, rules_version, status, text, diagnostics, control_state, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(documentId, RULES_VERSION, status, text, JSON.stringify(diagnostics),
      controlState, error, new Date().toISOString());
    return this.getExtraction(Number(res.lastInsertRowid));
  }

  getExtraction(id: number): ExtractionRow {
    const row = this.db.prepare(`SELECT * FROM extractions WHERE id = ?`).get(id) as
      | ExtractionRow | undefined;
    if (!row) throw new ApiError(404, "NOT_FOUND", `提取记录 ${id} 不存在`);
    return row;
  }

  latestExtraction(documentId: number): ExtractionRow {
    this.getDocument(documentId);
    const row = this.db.prepare(
      `SELECT * FROM extractions WHERE document_id = ? ORDER BY id DESC LIMIT 1`
    ).get(documentId) as ExtractionRow | undefined;
    if (!row) throw new ApiError(404, "NOT_FOUND", `文档 ${documentId} 尚无提取记录`);
    return row;
  }

  listExtractions(documentId: number): ExtractionRow[] {
    this.getDocument(documentId);
    return this.db.prepare(
      `SELECT * FROM extractions WHERE document_id = ? ORDER BY id`
    ).all(documentId) as unknown as ExtractionRow[];
  }
}
