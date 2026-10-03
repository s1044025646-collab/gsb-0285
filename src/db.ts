import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

export interface DocumentRow {
  id: number;
  name: string;
  sha256: string;
  source_path: string;
  copy_path: string;
  size: number;
  imported_at: string;
}

export interface ExtractionRow {
  id: number;
  document_id: number;
  rules_version: string;
  status: string;
  text: string | null;
  diagnostics: string;
  control_state: string | null;
  error: string | null;
  created_at: string;
}

export function openDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "files"), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "rtf.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      source_path TEXT NOT NULL,
      copy_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id),
      rules_version TEXT NOT NULL,
      status TEXT NOT NULL,
      text TEXT,
      diagnostics TEXT NOT NULL,
      control_state TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}
