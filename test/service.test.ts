import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb } from "../src/db.js";
import { RtfService } from "../src/service.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtf-test-"));
  const db = openDb(dir);
  return { dir, db, service: new RtfService(db, dir) };
}

const RTF = "{\\rtf1\\ansi\\ansicpg1252 Hello\\par \\u20013?\\u25991?}";

test("导入-提取-复查-导出全流程，源文件不被修改", () => {
  const { dir, db, service } = setup();
  const src = path.join(dir, "a.rtf");
  fs.writeFileSync(src, RTF, "latin1");
  const before = fs.readFileSync(src);

  const doc = service.importDocument(src);
  assert.equal(doc.sha256.length, 64);
  assert.ok(fs.existsSync(doc.copy_path));
  assert.deepEqual(fs.readFileSync(src), before);

  const ext = service.extract(doc.id);
  assert.equal(ext.status, "ok");
  assert.equal(ext.text, "Hello\n中文");
  assert.equal(ext.rules_version, "rtf-text-1.0.0");

  // 重启（重开数据库）后仍可复查
  db.close();
  const db2 = openDb(dir);
  const service2 = new RtfService(db2, dir);
  const latest = service2.latestExtraction(doc.id);
  assert.equal(latest.text, "Hello\n中文");
  db2.close();
});

test("失败提取与成功明确区分", () => {
  const { dir, service } = setup();
  const src = path.join(dir, "bad.rtf");
  fs.writeFileSync(src, "{\\rtf1\\ansi\\ansicpg936 x}", "latin1");
  const doc = service.importDocument(src);
  const ext = service.extract(doc.id);
  assert.equal(ext.status, "failed");
  assert.equal(ext.text, null);
  const err = JSON.parse(ext.error!);
  assert.equal(err.code, "RTF_UNSUPPORTED_CODEPAGE");
});

test("不存在的文件与文档报错", () => {
  const { service } = setup();
  assert.throws(() => service.importDocument("nope.rtf"), /文件不存在/);
  assert.throws(() => service.getDocument(999), /不存在/);
});
