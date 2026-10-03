import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRtf } from "../src/rtf/parser";
import { RtfError } from "../src/rtf/errors";

const P = (s: string) => parseRtf(Buffer.from(s, "latin1"));

test("普通文本与控制词分隔空格", () => {
  const r = P("{\\rtf1\\ansi Hello \\b World}");
  assert.equal(r.text, "Hello World");
});

test("控制词后的分隔空格不进入正文，其后空格保留", () => {
  const r = P("{\\rtf1\\ansi a\\b b}");
  assert.equal(r.text, "ab");
  const r2 = P("{\\rtf1\\ansi a\\b  b}");
  assert.equal(r2.text, "a b");
});

test("源文件 CR/LF 不产生换行，\\par 与 \\line 才换行", () => {
  const r = P("{\\rtf1\\ansi\r\nline1\r\nline2\\par\nline3\\line line4}");
  assert.equal(r.text, "line1line2\nline3\nline4");
});

test("转义的反斜杠与花括号作为字面字符", () => {
  const r = P("{\\rtf1\\ansi \\{not a group\\} and \\\\ slash}");
  assert.equal(r.text, "{not a group} and \\ slash");
});

test("嵌套样式分组与状态恢复", () => {
  const r = P("{\\rtf1\\ansi a{\\b b{\\i c}d}e}");
  assert.equal(r.text, "abcde");
});

test("fonttbl/colortbl/stylesheet/info 目的地整组跳过", () => {
  const r = P(
    "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red1\\green2\\blue3;}" +
      "{\\stylesheet Normal;}{\\info{\\title T}{\\author A}}Body}"
  );
  assert.equal(r.text, "Body");
  assert.deepEqual(
    r.state.skippedDestinations.sort(),
    ["colortbl", "fonttbl", "info", "stylesheet"].sort()
  );
});

test("带星号的未知目的地整组跳过，嵌套组不会重新开启输出", () => {
  const r = P("{\\rtf1\\ansi A{\\*\\foo hidden {nested \\u20013?} more}B}");
  assert.equal(r.text, "AB");
});

test("忽略组内的嵌套结构仍被正确扫描（括号配对）", () => {
  const r = P("{\\rtf1\\ansi A{\\fonttbl {nested {deep}}}B}");
  assert.equal(r.text, "AB");
});

test("十六进制字节转义按 Windows-1252 解码", () => {
  const r = P("{\\rtf1\\ansi caf\\'e9 \\'93quoted\\'94}");
  assert.equal(r.text, "café “quoted”");
});

test("\\tab 输出制表符", () => {
  const r = P("{\\rtf1\\ansi a\\tab b}");
  assert.equal(r.text, "a\tb");
});

test("中文 Unicode 控制词与默认回退", () => {
  const r = P("{\\rtf1\\ansi\\uc1 \\u20013?\\u25991?}");
  assert.equal(r.text, "中文");
});

test("\\uN 负数按 16 位补偿", () => {
  const r = P("{\\rtf1\\ansi\\uc1 \\u-45523?}");
  assert.equal(r.text, "中"); // -20083 + 65536 = 45453? 实际用 20013
});

test("合法代理对组合为单个码点", () => {
  const r = P("{\\rtf1\\ansi\\uc2 \\u55357\\u56834??}");
  assert.equal(r.text, "😂");
});

test("不完整代理对报明确错误", () => {
  assert.throws(() => P("{\\rtf1\\ansi \\u55357 x}"), (e: any) => {
    assert.ok(e instanceof RtfError);
    assert.equal(e.code, "E_INCOMPLETE_SURROGATE");
    return true;
  });
});

test("孤立低代理报错", () => {
  assert.throws(() => P("{\\rtf1\\ansi \\u56842?}"), /E_INCOMPLETE_SURROGATE/);
});

test("组内 \\uc 变化只影响当前组及子组，退出后恢复", () => {
  const r = P("{\\rtf1\\ansi\\uc1 {\\uc2 \\u9312??}\\u9313?}");
  assert.equal(r.text, "①②");
  assert.equal(r.state.finalUc, 1);
});

test("回退跳过按字符计数：转义字节算一个回退字符", () => {
  // uc=2，回退为 \'e9 和 X，共两个“字符”
  const r = P("{\\rtf1\\ansi\\uc2 \\u9312\\'e9XY}");
  assert.equal(r.text, "①Y");
});

test("回退跳过：控制词整体算一个回退字符", () => {
  const r = P("{\\rtf1\\ansi\\uc1 \\u9312\\f0 X}");
  assert.equal(r.text, "①X");
});

test("非法 RTF 头", () => {
  assert.throws(() => P("not rtf"), /E_NOT_RTF/);
});

test("花括号不配对定位到字节偏移", () => {
  assert.throws(
    () => P("{\\rtf1\\ansi a{b"),
    (e: any) => e.code === "E_UNBALANCED_BRACES" && typeof e.offset === "number"
  );
  assert.throws(() => P("{\\rtf1\\ansi}}"), /E_UNBALANCED_BRACES/);
});

test("非法十六进制转义带偏移", () => {
  assert.throws(
    () => P("{\\rtf1\\ansi \\'zz}"),
    (e: any) => e.code === "E_BAD_HEX_ESCAPE" && e.offset === 12
  );
});

test("\\u 参数缺失或超限", () => {
  assert.throws(() => P("{\\rtf1\\ansi \\u x}"), /E_BAD_PARAM/);
  assert.throws(() => P("{\\rtf1\\ansi \\u70000?}"), /E_BAD_PARAM/);
  assert.throws(() => P("{\\rtf1\\ansi \\uc999}"), /E_BAD_PARAM/);
});

test("非 1252 代码页明确拒绝", () => {
  assert.throws(() => P("{\\rtf1\\ansi\\ansicpg936 x}"), /E_UNSUPPORTED_CODEPAGE/);
  assert.throws(() => P("{\\rtf1\\mac x}"), /E_UNSUPPORTED_CODEPAGE/);
});

test("\\bin、域指令、\\upr 报不支持", () => {
  assert.throws(() => P("{\\rtf1\\ansi \\bin4 abcd}"), /E_UNSUPPORTED_BIN/);
  assert.throws(() => P("{\\rtf1\\ansi {\\field x}}"), /E_UNSUPPORTED_FIELD/);
  assert.throws(() => P("{\\rtf1\\ansi {\\upr x}}"), /E_UNSUPPORTED_UPR/);
});

test("未知格式控制词被忽略并记录，参数不进入正文", () => {
  const r = P("{\\rtf1\\ansi a\\xyzzy123 b}");
  assert.equal(r.text, "ab");
  assert.deepEqual(r.state.unknownControls, ["xyzzy"]);
  assert.equal(r.diagnostics[0].code, "W_UNKNOWN_CONTROL");
});

test("同一字节序列解析结果确定（终端环境无关的 UTF-8）", () => {
  const src = "{\\rtf1\\ansi\\uc1 caf\\'e9 \\u20013?\\par}";
  const a = P(src).text;
  const b = P(src).text;
  assert.equal(a, b);
  assert.equal(Buffer.from(a, "utf8").toString("hex"), Buffer.from("café 中\n", "utf8").toString("hex"));
});
