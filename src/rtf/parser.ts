/** RTF 纯文本提取器：自行解析分组与控制词，仅支持公开文本子集。 */

export const RULES_VERSION = "rtf-text-1.0.0";

export type DiagLevel = "error" | "unsupported" | "warning" | "info";

export interface Diagnostic {
  code: string;
  level: DiagLevel;
  message: string;
  offset?: number;
}

export interface ControlState {
  codepage: number;
  uc: number;
  destinationsSkipped: string[];
  unknownControls: string[];
}

export interface ExtractResult {
  ok: boolean;
  text: string;
  diagnostics: Diagnostic[];
  controlState: ControlState;
}

export class RtfError extends Error {
  constructor(public code: string, message: string, public offset?: number) {
    super(message);
  }
}

/** Windows-1252 中 0x80-0x9F 与 Latin-1 不同的映射 */
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function cp1252(byte: number): string {
  if (byte >= 0x80 && byte <= 0x9f && CP1252_HIGH[byte] !== undefined) {
    return String.fromCodePoint(CP1252_HIGH[byte]);
  }
  return String.fromCharCode(byte);
}

/** 非正文目的地：整组跳过 */
const SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object",
  "xmlnstbl", "datastore", "themedata", "colorschememapping",
  "latentstyles", "revtbl", "rsidtbl", "generator", "filetbl",
  "listtable", "listoverridetable", "shp", "annotation", "footer",
  "header", "footnote", "nonshppict", "shppict", "userprops",
]);

/** 明确不支持、需报错的结构 */
const UNSUPPORTED: Record<string, string> = {
  bin: "RTF_UNSUPPORTED_BIN",
  field: "RTF_UNSUPPORTED_FIELD",
  upr: "RTF_UNSUPPORTED_UPR",
};

/** 可忽略的基本样式控制词（参数不输出） */
const IGNORABLE_FORMAT = new Set([
  "ansi", "ansicpg", "deff", "deflang", "rtf", "pard", "plain", "b", "i",
  "ul", "ulnone", "strike", "sub", "super", "fs", "f", "cf", "cb", "highlight",
  "lang", "kerning", "expnd", "charscalex", "caps", "scaps", "v", "outl",
  "embo", "impr", "shad", "qc", "ql", "qr", "qj", "fi", "li", "ri", "sb",
  "sa", "sl", "slmult", "keepn", "keep", "widctlpar", "hyphpar", "nosnaplinegrid",
  "s", "cs", "additive", "sbasedon", "snext", "spersonal", "scompose", "sreply",
  "format", "fromtext", "viewkind", "viewscale", "paperw", "paperh", "margl",
  "margr", "margt", "margb", "facingp", "gutter", "deftab", "widowctrl",
  "fcharset", "fprq", "panose", "fname", "fbias", "ftnil", "fttruetype",
  "async", "nowwrap", "aspalpha", "aspnum", "adjustright", "nooverflow",
  "itap", "brdrt", "brdrb", "brdrl", "brdrr", "brsp", "tx", "tqc", "tqr",
  "tl", "tr", "tb", "pn", "lvl", "ilvl", "listtext", "lsdlockedexcept",
  "mmath", "mmathPr", "noline", "pgbrdrhead", "pgbrdrfoot", "sectd",
  "ltrpar", "rtlpar", "ltrch", "rtlch", "loch", "hich", "dbch", "af",
  "acccomma", "accdot", "uc", "u", "insrsid", "charrsid", "sectrsid",
  "pararsid", "styrsid", "cchs", "falt", "fs20", "red", "green", "blue",
]);

interface GroupState {
  ignorable: boolean;
  uc: number;
}

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isLetter = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
const isHex = (c: number) =>
  isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);

export function extractRtf(buf: Buffer): ExtractResult {
  const diagnostics: Diagnostic[] = [];
  const skippedDestinations = new Set<string>();
  const unknownControls = new Set<string>();
  let codepage = 1252;

  if (buf.length < 5 || buf[0] !== 0x7b || buf[1] !== 0x5c ||
      buf[2] !== 0x72 || buf[3] !== 0x74 || buf[4] !== 0x66) {
    throw new RtfError("RTF_INVALID_HEADER",
      "文件缺少合法 RTF 头（应以 {\\rtf 开头）", 0);
  }

  const out: string[] = [];
  const stack: GroupState[] = [{ ignorable: false, uc: 1 }];
  const top = () => stack[stack.length - 1];

  let pos = 0;
  const len = buf.length;

  function skipFallbackChars(count: number, atOffset: number): void {
    for (let n = 0; n < count; n++) {
      if (pos >= len) return;
      if (buf[pos] === 0x5c && pos + 3 < len && buf[pos + 1] === 0x27 &&
          isHex(buf[pos + 2]) && isHex(buf[pos + 3])) {
        pos += 4; // 转义字节整体作为一个回退字符
      } else if (buf[pos] === 0x5c && pos + 1 < len) {
        pos += 2; // 其他反斜杠转义单字符
      } else {
        pos += 1;
      }
    }
    void atOffset;
  }

  while (pos < len) {
    const b = buf[pos];

    if (b === 0x7b) { // {
      stack.push({ ignorable: top().ignorable, uc: top().uc });
      pos++;
      continue;
    }
    if (b === 0x7d) { // }
      if (stack.length <= 1) {
        throw new RtfError("RTF_UNBALANCED_BRACE",
          "花括号不配对：多余的 }", pos);
      }
      stack.pop();
      pos++;
      continue;
    }
    if (b === 0x0d || b === 0x0a) { // 源文件排版 CR/LF，不进入文本
      pos++;
      continue;
    }

    if (b === 0x5c) { // 反斜杠
      const start = pos;
      pos++;
      if (pos >= len) {
        throw new RtfError("RTF_BAD_ESCAPE", "反斜杠后缺少内容", start);
      }
      const c = buf[pos];

      // 转义字面字符
      if (c === 0x5c || c === 0x7b || c === 0x7d) { // \\ \{ \}
        if (!top().ignorable) out.push(String.fromCharCode(c));
        pos++;
        continue;
      }
      // 十六进制字节转义 \'hh
      if (c === 0x27) {
        if (pos + 2 >= len || !isHex(buf[pos + 1]) || !isHex(buf[pos + 2])) {
          throw new RtfError("RTF_BAD_HEX",
            "非法十六进制转义：\\' 后需两个十六进制字符", start);
        }
        const byte = parseInt(buf.toString("latin1", pos + 1, pos + 3), 16);
        if (!top().ignorable) out.push(cp1252(byte));
        pos += 3;
        continue;
      }
      // \* 未知目的地标记
      if (c === 0x2a) {
        top().ignorable = true;
        skippedDestinations.add("*");
        pos++;
        continue;
      }
      // 控制符号（非字母）
      if (!isLetter(c)) {
        const sym = String.fromCharCode(c);
        if (!top().ignorable) {
          if (sym === "~") out.push(" ");
          else if (sym === "-") { /* 软连字符，不输出 */ }
          else if (sym === "_") out.push("‑"); // 非断行连字符
        }
        pos++;
        continue;
      }
      // 控制词
      let nameStart = pos;
      while (pos < len && isLetter(buf[pos])) pos++;
      const name = buf.toString("latin1", nameStart, pos);
      let negative = false;
      if (pos < len && buf[pos] === 0x2d) { negative = true; pos++; }
      let paramStr = "";
      while (pos < len && isDigit(buf[pos])) { paramStr += String.fromCharCode(buf[pos]); pos++; }
      const param = paramStr === "" ? null : (negative ? -1 : 1) * parseInt(paramStr, 10);
      // 分隔空格
      if (pos < len && buf[pos] === 0x20) pos++;

      // 不支持的结构
      if (UNSUPPORTED[name]) {
        throw new RtfError(UNSUPPORTED[name],
          `不支持的结构 \\${name}（原始二进制/复杂域/替代 Unicode 目的地）`, start);
      }

      if (name === "uc") {
        if (param === null || param < 0 || param > 10) {
          throw new RtfError("RTF_BAD_PARAM",
            "\\uc 参数缺失或超出范围（0-10）", start);
        }
        top().uc = param;
        continue;
      }
      if (name === "u") {
        if (param === null || param < -32768 || param > 32767) {
          throw new RtfError("RTF_BAD_PARAM",
            "\\u 参数缺失或超出有符号 16 位范围", start);
        }
        let unit = param < 0 ? param + 65536 : param;
        if (unit >= 0xd800 && unit <= 0xdbff) {
          // 高代理：先按 uc 跳过自身回退字符，再要求紧跟 \uN 低代理
          skipFallbackChars(top().uc, pos);
          if (pos + 1 < len && buf[pos] === 0x5c && buf[pos + 1] === 0x75) {
            pos += 2;
            let neg2 = false;
            if (pos < len && buf[pos] === 0x2d) { neg2 = true; pos++; }
            let p2 = "";
            while (pos < len && isDigit(buf[pos])) { p2 += String.fromCharCode(buf[pos]); pos++; }
            if (pos < len && buf[pos] === 0x20) pos++;
            if (p2 === "") {
              throw new RtfError("RTF_INCOMPLETE_SURROGATE",
                "高代理后 \\u 缺少参数", start);
            }
            let low = (neg2 ? -1 : 1) * parseInt(p2, 10);
            if (low < 0) low += 65536;
            if (low < 0xdc00 || low > 0xdfff) {
              throw new RtfError("RTF_INCOMPLETE_SURROGATE",
                "高代理后未跟随合法低代理", start);
            }
            if (!top().ignorable) {
              out.push(String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)));
            }
            skipFallbackChars(top().uc, pos);
          } else {
            throw new RtfError("RTF_INCOMPLETE_SURROGATE",
              "不完整代理对：高代理后缺少 \\u 低代理", start);
          }
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          throw new RtfError("RTF_INCOMPLETE_SURROGATE",
            "孤立低代理，无法组合", start);
        } else {
          if (!top().ignorable) out.push(String.fromCharCode(unit));
          skipFallbackChars(top().uc, pos);
        }
        continue;
      }
      if (name === "ansicpg") {
        if (param === null) {
          throw new RtfError("RTF_BAD_PARAM", "\\ansicpg 缺少参数", start);
        }
        if (param !== 1252) {
          throw new RtfError("RTF_UNSUPPORTED_CODEPAGE",
            `仅支持 Windows-1252 代码页，拒绝代码页 ${param}`, start);
        }
        codepage = param;
        continue;
      }
      if (name === "par" || name === "line") {
        if (!top().ignorable) out.push("\n");
        continue;
      }
      if (name === "tab") {
        if (!top().ignorable) out.push("\t");
        continue;
      }
      if (name === "emdash") { if (!top().ignorable) out.push("—"); continue; }
      if (name === "endash") { if (!top().ignorable) out.push("–"); continue; }
      if (name === "lquote") { if (!top().ignorable) out.push("‘"); continue; }
      if (name === "rquote") { if (!top().ignorable) out.push("’"); continue; }
      if (name === "ldblquote") { if (!top().ignorable) out.push("“"); continue; }
      if (name === "rdblquote") { if (!top().ignorable) out.push("”"); continue; }
      if (name === "bullet") { if (!top().ignorable) out.push("•"); continue; }

      if (SKIP_DESTINATIONS.has(name)) {
        top().ignorable = true;
        skippedDestinations.add(name);
        continue;
      }
      if (IGNORABLE_FORMAT.has(name)) continue;

      if (top().ignorable) continue; // 忽略目的地内的控制词不记录
      unknownControls.add(name);
      diagnostics.push({
        code: "RTF_UNKNOWN_CONTROL",
        level: "info",
        message: `忽略未知控制词 \\${name}${param !== null ? " " + param : ""}`,
        offset: start,
      });
      continue;
    }

    // 普通文本字节（cp1252）
    if (!top().ignorable) out.push(cp1252(b));
    pos++;
  }

  if (stack.length !== 1) {
    throw new RtfError("RTF_UNBALANCED_BRACE",
      `花括号不配对：文档结束时仍有 ${stack.length - 1} 个未闭合的 {`, len);
  }

  if (skippedDestinations.size > 0) {
    diagnostics.push({
      code: "RTF_DESTINATIONS_SKIPPED",
      level: "info",
      message: `已跳过非正文目的地：${[...skippedDestinations].join(", ")}`,
    });
  }

  return {
    ok: true,
    text: out.join(""),
    diagnostics,
    controlState: {
      codepage,
      uc: stack[0].uc,
      destinationsSkipped: [...skippedDestinations],
      unknownControls: [...unknownControls],
    },
  };
}
