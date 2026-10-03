import { cp1252ToUnicode } from "./cp1252";
import { Diagnostic, RtfError } from "./errors";

export const RULES_VERSION = "rtf-text-rules/1.0.0";

export interface ParseStateSummary {
  codepage: "windows-1252";
  finalUc: number;
  maxGroupDepth: number;
  unknownControls: string[];
  skippedDestinations: string[];
  unsupported: string[];
}

export interface ParseResult {
  text: string;
  diagnostics: Diagnostic[];
  state: ParseStateSummary;
}

interface GroupState {
  ignorable: boolean;
  uc: number;
}

// 整组跳过的非正文目的地
const SKIPPABLE_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object",
  "generator", "filetbl", "listtable", "revtbl", "rsidtbl",
  "xmlnstbl", "userprops", "docvar", "shp", "shppict", "nonshppict",
  "latentstyles", "datastore", "themedata", "colorschememapping",
  "fontemb", "fileinfo", "datafield", "annotation", "atnid",
]);

// 可忽略的基本样式/结构控制词（参数已被词法层消费，不进入正文）
const KNOWN_IGNORABLE = new Set([
  "rtf", "ansi", "deff", "deflang", "deflangfe", "uc", "pard", "plain",
  "b", "i", "ul", "ulnone", "strike", "sub", "super", "nosupersub",
  "fs", "f", "cf", "cb", "highlight", "lang", "langfe", "kerning",
  "qc", "ql", "qr", "qj", "li", "ri", "fi", "sb", "sa", "sl", "slmult",
  "keepn", "keep", "widowctrl", "viewkind", "paperw", "paperh",
  "margl", "margr", "margt", "margb", "sectd", "sbknone", "pgnstart",
  "fcharset", "fprq", "panose", "fname", "fbias", "flomajor", "fhimajor",
  "fdbmajor", "fbimajor", "flominor", "fhiminor", "fdbminor", "fbiminor",
  "red", "green", "blue", "afs", "ai", "ab", "caps", "scaps", "v",
  "expnd", "expndtw", "cchs", "dbch", "loch", "hich", "animtext",
  "embo", "impr", "outl", "shad", "striked", "uldb", "uld", "uldash",
  "ulth", "ulw", "ulwave", "webhidden", "charscalex", "charscaley",
]);

function isLetter(b: number): boolean {
  return (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a);
}
function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}
function isHex(b: number): boolean {
  return isDigit(b) || (b >= 0x61 && b <= 0x66) || (b >= 0x41 && b <= 0x46);
}

export function parseRtf(buf: Buffer): ParseResult {
  if (
    buf.length < 6 ||
    buf[0] !== 0x7b || // {
    buf[1] !== 0x5c || // \
    buf[2] !== 0x72 || // r
    buf[3] !== 0x74 || // t
    buf[4] !== 0x66 || // f
    buf[5] !== 0x31 // 1
  ) {
    throw new RtfError("E_NOT_RTF", "文件缺少合法的 RTF 头（应以 {\\rtf1 开头）", 0);
  }

  const diagnostics: Diagnostic[] = [];
  const out: string[] = [];
  const stack: GroupState[] = [{ ignorable: false, uc: 1 }];
  const unknownControls = new Set<string>();
  const skippedDestinations = new Set<string>();
  const unsupported = new Set<string>();
  let maxDepth = 1;
  let pos = 0;

  const cur = (): GroupState => stack[stack.length - 1];

  const emit = (s: string) => {
    if (!cur().ignorable) out.push(s);
  };

  const emitByte = (byte: number, offset: number) => {
    const cp = cp1252ToUnicode(byte);
    if (cp === null) {
      diagnostics.push({
        severity: "warning",
        code: "W_UNMAPPED_BYTE",
        message: `Windows-1252 未定义字节 0x${byte.toString(16)}，已忽略`,
        offset,
      });
      return;
    }
    emit(String.fromCodePoint(cp));
  };

  // 读取一个控制词/控制符号（pos 指向反斜杠之后），返回名称与数值参数
  function readControl(): { word: string | null; symbol: string | null; param: number | null; start: number } {
    const start = pos - 1; // 反斜杠位置
    const b = buf[pos];
    if (!isLetter(b)) {
      pos++;
      return { word: null, symbol: String.fromCharCode(b), param: null, start };
    }
    let w = "";
    while (pos < buf.length && isLetter(buf[pos])) {
      w += String.fromCharCode(buf[pos]);
      pos++;
    }
    let param: number | null = null;
    let sign = 1;
    if (pos < buf.length && buf[pos] === 0x2d) {
      sign = -1;
      pos++;
    }
    if (pos < buf.length && isDigit(buf[pos])) {
      let n = 0;
      while (pos < buf.length && isDigit(buf[pos])) {
        n = n * 10 + (buf[pos] - 0x30);
        pos++;
      }
      param = sign * n;
    } else if (sign === -1) {
      throw new RtfError("E_BAD_PARAM", `控制词 \\${w} 的负号后缺少数字`, pos);
    }
    // 控制词后的单个空格是分隔符，不属于正文
    if (pos < buf.length && buf[pos] === 0x20) pos++;
    return { word: w, symbol: null, param, start };
  }

  // 跳过一个“字符”（用于 \u 回退）：控制词/符号整体算 1 个字符
  function skipOneChar() {
    if (pos >= buf.length) return;
    const b = buf[pos];
    if (b === 0x0d || b === 0x0a) {
      pos++;
      skipOneChar();
      return;
    }
    if (b === 0x5c) {
      pos++;
      if (pos < buf.length) {
        if (isLetter(buf[pos])) {
          readControl(); // 整个控制词算一个回退字符
        } else if (buf[pos] === 0x27 && pos + 2 < buf.length) {
          pos += 3; // \'hh 转义字节算一个回退字符
        } else {
          pos++;
        }
      }
      return;
    }
    pos++;
  }

  function skipFallbackChars(count: number, offset: number) {
    for (let i = 0; i < count; i++) {
      if (pos >= buf.length) {
        throw new RtfError("E_TRUNCATED", "\\u 回退字符超出文件末尾", offset);
      }
      skipOneChar();
    }
  }

  function handleUnicodeEscape(param: number | null, start: number) {
    if (param === null || param < -65536 || param > 65535) {
      throw new RtfError("E_BAD_PARAM", "\\u 参数缺失或超出 16 位范围", start);
    }
    let unit = param < 0 ? param + 65536 : param;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      // 高代理：必须紧跟 \uN 低代理
      const save = pos;
      if (pos < buf.length && buf[pos] === 0x5c) {
        pos++;
        const next = readControl();
        if (next.word === "u" && next.param !== null) {
          const lo = next.param < 0 ? next.param + 65536 : next.param;
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            const cp = 0x10000 + ((unit - 0xd800) << 10) + (lo - 0xdc00);
            emit(String.fromCodePoint(cp));
            skipFallbackChars(cur().uc, start);
            return;
          }
        }
      }
      pos = save;
      throw new RtfError("E_INCOMPLETE_SURROGATE", "高代理后缺少合法的 \\u 低代理", start);
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new RtfError("E_INCOMPLETE_SURROGATE", "出现孤立的低代理", start);
    }
    emit(String.fromCharCode(unit));
    skipFallbackChars(cur().uc, start);
  }

  function dispatchWord(word: string, param: number | null, start: number) {
    switch (word) {
      case "par":
      case "line":
      case "sect":
        emit("\n");
        return;
      case "tab":
        emit("\t");
        return;
      case "emdash":
        emit("—");
        return;
      case "endash":
        emit("–");
        return;
      case "bullet":
        emit("•");
        return;
      case "lquote":
        emit("‘");
        return;
      case "rquote":
        emit("’");
        return;
      case "ldblquote":
        emit("“");
        return;
      case "rdblquote":
        emit("”");
        return;
      case "uc":
        if (param === null || param < 0 || param > 255) {
          throw new RtfError("E_BAD_PARAM", "\\uc 参数缺失或超出 0-255 范围", start);
        }
        cur().uc = param;
        return;
      case "u":
        handleUnicodeEscape(param, start);
        return;
      case "ansicpg":
        if (param !== 1252) {
          throw new RtfError(
            "E_UNSUPPORTED_CODEPAGE",
            `仅支持 ANSI 代码页 Windows-1252，收到 ${param}`,
            start
          );
        }
        return;
      case "mac":
      case "pc":
      case "pca":
        throw new RtfError("E_UNSUPPORTED_CODEPAGE", `仅支持 \\ansi（Windows-1252），不支持 \\${word}`, start);
      case "bin":
        unsupported.add("bin");
        throw new RtfError("E_UNSUPPORTED_BIN", "不支持原始二进制载荷 \\bin", start);
      case "field":
      case "fldinst":
      case "fldrslt":
        unsupported.add("field");
        throw new RtfError("E_UNSUPPORTED_FIELD", "不支持复杂域指令", start);
      case "upr":
        unsupported.add("upr");
        throw new RtfError("E_UNSUPPORTED_UPR", "不支持替代 Unicode 目的地 \\upr", start);
      default:
        break;
    }
    if (SKIPPABLE_DESTINATIONS.has(word)) {
      cur().ignorable = true;
      skippedDestinations.add(word);
      return;
    }
    if (KNOWN_IGNORABLE.has(word) || cur().ignorable) return;
    unknownControls.add(word);
    diagnostics.push({
      severity: "warning",
      code: "W_UNKNOWN_CONTROL",
      message: `忽略未知控制词 \\${word}`,
      offset: start,
    });
  }

  function handleControl() {
    pos++; // 跳过反斜杠
    if (pos >= buf.length) {
      throw new RtfError("E_TRUNCATED", "文件以反斜杠结尾", pos - 1);
    }
    const t = readControl();
    if (t.word !== null) {
      dispatchWord(t.word, t.param, t.start);
      return;
    }
    const sym = t.symbol!;
    switch (sym) {
      case "{":
        emit("{");
        return;
      case "}":
        emit("}");
        return;
      case "\\":
        emit("\\");
        return;
      case "'": {
        if (pos + 1 >= buf.length || !isHex(buf[pos]) || !isHex(buf[pos + 1])) {
          throw new RtfError("E_BAD_HEX_ESCAPE", "非法十六进制字节转义（需要 \\'hh）", t.start);
        }
        const byte = parseInt(buf.toString("ascii", pos, pos + 2), 16);
        pos += 2;
        emitByte(byte, t.start);
        return;
      }
      case "*":
        // 带星号标记的未知目的地：整组跳过
        cur().ignorable = true;
        skippedDestinations.add("*");
        return;
      case "~":
        emit(" ");
        return;
      case "_":
        emit("‑");
        return;
      case "-":
        return; // 可选连字符，不输出
      case "|":
        return;
      default:
        diagnostics.push({
          severity: "warning",
          code: "W_UNKNOWN_SYMBOL",
          message: `忽略未知控制符号 \\${sym}`,
          offset: t.start,
        });
    }
  }

  while (pos < buf.length) {
    const b = buf[pos];
    if (b === 0x7b) {
      stack.push({ ...cur() });
      if (stack.length > maxDepth) maxDepth = stack.length;
      pos++;
    } else if (b === 0x7d) {
      if (stack.length <= 1) {
        throw new RtfError("E_UNBALANCED_BRACES", "多余的右花括号", pos);
      }
      stack.pop();
      pos++;
    } else if (b === 0x5c) {
      handleControl();
    } else if (b === 0x0d || b === 0x0a) {
      pos++; // 源文件排版换行不进入正文
    } else if (b === 0x09) {
      emit("\t");
      pos++;
    } else {
      emitByte(b, pos);
      pos++;
    }
  }

  if (stack.length !== 1) {
    throw new RtfError("E_UNBALANCED_BRACES", `文件结束时仍有 ${stack.length - 1} 个未闭合的分组`, buf.length);
  }

  return {
    text: out.join(""),
    diagnostics,
    state: {
      codepage: "windows-1252",
      finalUc: cur().uc,
      maxGroupDepth: maxDepth,
      unknownControls: [...unknownControls],
      skippedDestinations: [...skippedDestinations],
      unsupported: [...unsupported],
    },
  };
}
