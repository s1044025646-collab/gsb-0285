// 演示：同一文件导入、提取，并以十六进制展示 UTF-8 输出，
// 证明与终端代码页无关（输出为 UTF-8 字节流）。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sample = [
  "{\\rtf1\\ansi\\ansicpg1252\\deff0",
  "{\\fonttbl{\\f0 Arial;}{\\f1{\\*\\falt SimSun};}}",
  "{\\colortbl;\\red255\\green0\\blue0;}",
  "{\\info{\\title Demo}{\\author Tester}}",
  "\\pard\\b Bold Text\\b0\\par",
  "caf\\'e9 \\'93quoted\\'94\\par",
  "{\\uc2\\u20013??\\u25991??}\\uc1\\u-29715?\\u-29715?\\par",
  "\\u-10179?\\u-8704? done\\par",
  "tab\\tab here\\line end}",
].join("\r\n");

fs.mkdirSync("demo", { recursive: true });
fs.writeFileSync("demo/sample.rtf", sample, "latin1");
console.log("== 示例 RTF 已写入 demo/sample.rtf ==\n");

const cli = ["dist/src/cli.js"];
const run = (args) => execFileSync(process.execPath, [...cli, ...args], { encoding: "utf8" });

console.log("== import ==");
const doc = JSON.parse(run(["import", "demo/sample.rtf"]));
console.log(`document id=${doc.id} sha256=${doc.sha256.slice(0, 16)}...`);

console.log("\n== extract ==");
const ext = JSON.parse(run(["extract", String(doc.id)]));
console.log(`extraction id=${ext.id} status=${ext.status} rules=${ext.rules_version}`);

console.log("\n== text（UTF-8 字节十六进制，证明与终端编码无关）==");
const text = run(["text", String(doc.id)]);
process.stdout.write(text);
console.log("hex:", Buffer.from(text, "utf8").toString("hex"));

console.log("\n== state ==");
console.log(run(["state", String(doc.id)]));

console.log("\n== export ==");
console.log(run(["export", String(ext.id), "txt", "demo/out.txt"]));
console.log(run(["export", String(ext.id), "json", "demo/out.json"]));
console.log("\n演示完成。数据目录：", path.resolve("data"));
