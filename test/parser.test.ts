import test from "node:test";
import assert from "node:assert/strict";
import { extractRtf, RtfError } from "../src/rtf/parser.js";

const enc = (s: string) => Buffer.from(s, "latin1");
const H = "{\\rtf1\\ansi\\ansicpg1252 ";

test("普通文本与段落控制词", () => {
  const r = extractRtf(enc(H + "Hello\\par World}"));
  assert.equal(r.text, "Hello\nWorld");
});

test("源文件 CR/LF 不产生换行", () => {
  const r = extractRtf(enc(H + "ab\r\ncd}"));
  assert.equal(r.text, "abcd");
});

test("控制词后的分隔空格被吞掉，普通空格保留", () => {
  const r = extractRtf(enc(H + "a\\par b c}"));
  assert.equal(r.text, "a\nb c");
});

test("转义的反斜杠与花括号", () => {
  const r = extractRtf(enc(H + "a\\\\b\\{c\\}d}"));
  assert.equal(r.text, "a\\b{c}d");
});

test("嵌套样式组与组状态恢复", () => {
  const r = extractRtf(enc(H + "A{\\b B{\\i C}D}E}"));
  assert.equal(r.text, "ABCDE");
});

test("fonttbl 等目的地整组跳过，嵌套组不重启正文", () => {
  const r = extractRtf(enc(
    H + "X{\\fonttbl{\\f0 Arial;}{\\f1{Nested}}}Y{\\*\\unknown Z}W}"
  ));
  assert.equal(r.text, "XYW");
  assert.ok(r.controlState.destinationsSkipped.includes("fonttbl"));
  assert.ok(r.controlState.destinationsSkipped.includes("*"));
});

test("colortbl / stylesheet / info 跳过", () => {
  const r = extractRtf(enc(
    H + "{\\colortbl;\\red255\\green0\\blue0;}{\\stylesheet S}{\\info{\\title T}}Body}"
  ));
  assert.equal(r.text, "Body");
});

test("\\line 与 \\tab", () => {
  const r = extractRtf(enc(H + "a\\line b\\tab c}"));
  assert.equal(r.text, "a\nb\tc");
});

test("十六进制字节转义按 Windows-1252 解码", () => {
  const r = extractRtf(enc(H + "caf\\'e9 \\'93Q\\'94 \\'80}"));
  assert.equal(r.text, "café “Q” €");
});

test("非法十六进制转义报错并带偏移", () => {
  assert.throws(() => extractRtf(enc(H + "a\\'xz}")), (e: unknown) => {
    assert.ok(e instanceof RtfError);
    assert.equal((e as RtfError).code, "RTF_BAD_HEX");
    assert.equal(typeof (e as RtfError).offset, "number");
    return true;
  });
});

test("中文 Unicode 控制词与默认回退", () => {
  // 中 = U+4E2D = 20013，文 = 25991；uc 默认 1，各带一个回退字节 '?'
  const r = extractRtf(enc(H + "\\u20013?\\u25991?}"));
  assert.equal(r.text, "中文");
});

test("\\u 负数按 16 位补偿", () => {
  // 语 U+8BED = 35821，写为 35821-65536 = -29715
  const r = extractRtf(enc(H + "\\u-29715?}"));
  assert.equal(r.text, "语");
});

test("组内 uc 变化控制回退跳过数量，退出组恢复", () => {
  // 组内 uc=2：\\u20013 后跳过 2 个回退字符 "??"；出组后恢复 uc=1
  const r = extractRtf(enc(H + "{\\uc2\\u20013??}A\\u25991?}"));
  assert.equal(r.text, "中A文");
  assert.equal(r.controlState.uc, 1);
});

test("回退字符中 \\'hh 转义字节算一个字符", () => {
  // uc=2，回退为 \'3f\'3f（两个转义字节），之后正文 A 不被吞
  const r = extractRtf(enc(H + "{\\uc2\\u20013\\'3f\\'3f}A}"));
  assert.equal(r.text, "中A");
});

test("代理对组合为单个码点", () => {
  // 😀 U+1F600 -> 高 0xD83D=55357(-10179), 低 0xDE00=56832(-8704)
  const r = extractRtf(enc(H + "\\u-10179?\\u-8704?}"));
  assert.equal(r.text, "😀");
});

test("不完整代理对报明确错误", () => {
  assert.throws(() => extractRtf(enc(H + "\\u-10179?A}")), (e: unknown) => {
    assert.ok(e instanceof RtfError);
    assert.equal(e.code, "RTF_INCOMPLETE_SURROGATE");
    return true;
  });
  assert.throws(() => extractRtf(enc(H + "\\u-8704?}")), (e: unknown) => {
    assert.equal((e as RtfError).code, "RTF_INCOMPLETE_SURROGATE");
    return true;
  });
});

test("花括号不配对报错并定位", () => {
  assert.throws(() => extractRtf(enc(H + "a{b")), (e: unknown) => {
    assert.equal((e as RtfError).code, "RTF_UNBALANCED_BRACE");
    return true;
  });
  assert.throws(() => extractRtf(enc(H + "a}}")), (e: unknown) => {
    assert.equal((e as RtfError).code, "RTF_UNBALANCED_BRACE");
    assert.equal(typeof (e as RtfError).offset, "number");
    return true;
  });
});

test("非法 RTF 头拒绝", () => {
  assert.throws(() => extractRtf(enc("hello world")), (e: unknown) => {
    assert.equal((e as RtfError).code, "RTF_INVALID_HEADER");
    return true;
  });
});

test("非 1252 代码页明确拒绝", () => {
  assert.throws(
    () => extractRtf(enc("{\\rtf1\\ansi\\ansicpg936 abc}")),
    (e: unknown) => {
      assert.equal((e as RtfError).code, "RTF_UNSUPPORTED_CODEPAGE");
      return true;
    }
  );
});

test("\\bin / \\field / \\upr 报不支持", () => {
  for (const [src, code] of [
    [H + "{\\bin4 abcd}", "RTF_UNSUPPORTED_BIN"],
    [H + "{\\field{\\fldinst HYPERLINK}}", "RTF_UNSUPPORTED_FIELD"],
    [H + "{\\upr abc}{\\ud def}", "RTF_UNSUPPORTED_UPR"],
  ] as const) {
    assert.throws(() => extractRtf(enc(src)), (e: unknown) => {
      assert.equal((e as RtfError).code, code);
      return true;
    });
  }
});

test("未知控制词忽略并记录，参数不进入正文", () => {
  const r = extractRtf(enc(H + "a\\somecmd123 b}"));
  assert.equal(r.text, "ab");
  assert.ok(r.controlState.unknownControls.includes("somecmd"));
  assert.ok(r.diagnostics.some((d) => d.code === "RTF_UNKNOWN_CONTROL"));
});

test("\\u 参数缺失或超限报错", () => {
  assert.throws(() => extractRtf(enc(H + "\\u abc}")), (e: unknown) => {
    assert.equal((e as RtfError).code, "RTF_BAD_PARAM");
    return true;
  });
  assert.throws(() => extractRtf(enc(H + "\\u40000?}")), (e: unknown) => {
    assert.equal((e as RtfError).code, "RTF_BAD_PARAM");
    return true;
  });
});

test("忽略目的地内的嵌套结构仍被正确扫描", () => {
  // fonttbl 内有不平衡风险的内容与嵌套组，必须完整跳过且括号配对正确
  const r = extractRtf(enc(H + "A{\\fonttbl{\\f0{\\*\\falt Ar;ial}\\'5c}}B}"));
  assert.equal(r.text, "AB");
});
