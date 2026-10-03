import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

export interface DocumentRow {
  id: number;
  name: string;
  sha256: string;
  size: number;
  source_path: string;
  stored_path: string;
  imported_at: string;
}

export interface ExtractionRow {
  id: number;
  document_id: number;
  rules_version: string;
  status: string;
  text: string | null;
  diagnostics: string;
  state: string | null;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly filesDir: string;
  readonly exportsDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.filesDir = path.join(this.dataDir, "files");
    this.exportsDir = path.join(this.dataDir, "exports");
    for (const d of [this.dataDir, this.filesDir, this.exportsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    this.db = new DatabaseSync(path.join(this.dataDir, "rtf.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        source_path TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS extractions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        rules_version TEXT NOT NULL,
        status TEXT NOT NULL,
        text TEXT,
        diagnostics TEXT NOT NULL,
        state TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  insertDocument(doc: Omit<DocumentRow, "id">): number {
    const r = this.db
      .prepare(
        `INSERT INTO documents (name, sha256, size, source_path, stored_path, imported_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(doc.name, doc.sha256, doc.size, doc.source_path, doc.stored_path, doc.imported_at);
    return Number(r.lastInsertRowid);
  }

  getDocument(id: number): DocumentRow | undefined {
    return this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as
      | DocumentRow
      | undefined;
  }

  listDocuments(): DocumentRow[] {
    return this.db.prepare(`SELECT * FROM documents ORDER BY id`).all() as unknown as DocumentRow[];
  }

  insertExtraction(ex: Omit<ExtractionRow, "id">): number {
    const r = this.db
      .prepare(
        `INSERT INTO extractions (document_id, rules_version, status, text, diagnostics, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ex.document_id,
        ex.rules_version,
        ex.status,
        ex.text,
        ex.diagnostics,
        ex.state,
        ex.created_at
      );
    return Number(r.lastInsertRowid);
  }

  getExtraction(id: number): ExtractionRow | undefined {
    return this.db.prepare(`SELECT * FROM extractions WHERE id = ?`).get(id) as
      | ExtractionRow
      | undefined;
  }

  latestExtraction(documentId: number): ExtractionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM extractions WHERE document_id = ? ORDER BY id DESC LIMIT 1`)
      .get(documentId) as ExtractionRow | undefined;
  }

  listExtractions(documentId: number): ExtractionRow[] {
    return this.db
      .prepare(`SELECT * FROM extractions WHERE document_id = ? ORDER BY id`)
      .all(documentId) as unknown as ExtractionRow[];
  }

  close() {
    this.db.close();
  }
}
