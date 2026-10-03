import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/app/db";
import { RtfService } from "../src/app/service";
import { createServer } from "../src/app/http";

let dir: string;
let service: RtfService;
let samplePath: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtf-test-"));
  service = new RtfService(new Store(path.join(dir, "data")));
  samplePath = path.join(dir, "sample.rtf");
  fs.writeFileSync(
    samplePath,
    Buffer.from("{\\rtf1\\ansi\\uc1 {\\fonttbl{\\f0 A;}}Hi \\u20013?\\par}", "latin1")
  );
});

after(() => {
  service.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("导入 -> 提取 -> 诊断 -> 状态 -> 导出 -> 重启复查", () => {
  const doc = service.importFile(samplePath);
  assert.equal(doc.name, "sample.rtf");
  assert.ok(fs.existsSync(doc.stored_path));

  const ex = service.extract(doc.id);
  assert.equal(ex.status, "ok");
  assert.equal(ex.text, "Hi 中\n");
  assert.equal(ex.rulesVersion, "rtf-text-rules/1.0.0");

  const state: any = service.latest(doc.id).state;
  assert.equal(state.codepage, "windows-1252");
  assert.deepEqual(state.skippedDestinations, ["fonttbl"]);

  const out = service.export(ex.id, "txt");
  assert.equal(fs.readFileSync(out.path, "utf8"), "Hi 中\n");
  const outJson = service.export(ex.id, "json");
  assert.equal(JSON.parse(fs.readFileSync(outJson.path, "utf8")).text, "Hi 中\n");

  // 模拟重启：用同一数据目录新建 Store
  const service2 = new RtfService(new Store(path.join(dir, "data")));
  const again = service2.latest(doc.id);
  assert.equal(again.text, "Hi 中\n");
  assert.equal(service2.store.getDocument(doc.id)!.sha256, doc.sha256);
  service2.store.close();
});

test("失败提取与成功输出明确区分，失败不可导出", () => {
  const bad = path.join(dir, "bad.rtf");
  fs.writeFileSync(bad, Buffer.from("{\\rtf1\\ansi\\ansicpg936 x}", "latin1"));
  const doc = service.importFile(bad);
  const ex = service.extract(doc.id);
  assert.equal(ex.status, "failed");
  assert.equal(ex.text, null);
  assert.equal(ex.diagnostics[0].code, "E_UNSUPPORTED_CODEPAGE");
  assert.throws(() => service.export(ex.id, "txt"), /E_EXTRACTION_FAILED/);
});

test("HTTP API 端到端", async () => {
  const server = createServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const imp = await fetch(`${base}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: samplePath }),
    });
    assert.equal(imp.status, 201);
    const doc: any = await imp.json();

    const ext = await fetch(`${base}/documents/${doc.id}/extract`, { method: "POST" });
    const ex: any = await ext.json();
    assert.equal(ex.text, "Hi 中\n");

    const diag = await (await fetch(`${base}/documents/${doc.id}/diagnostics`)).json();
    assert.ok(Array.isArray(diag));

    const exp = await (await fetch(`${base}/extractions/${ex.id}/export?format=txt`)).json();
    assert.equal(exp.content, "Hi 中\n");

    const bad = await fetch(`${base}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "E_BAD_PARAM");
  } finally {
    server.close();
  }
});
