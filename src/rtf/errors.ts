export type ErrorCode =
  | "E_NOT_RTF"
  | "E_UNBALANCED_BRACES"
  | "E_BAD_HEX_ESCAPE"
  | "E_BAD_PARAM"
  | "E_UNSUPPORTED_CODEPAGE"
  | "E_UNSUPPORTED_BIN"
  | "E_UNSUPPORTED_FIELD"
  | "E_UNSUPPORTED_UPR"
  | "E_INCOMPLETE_SURROGATE"
  | "E_TRUNCATED";

export class RtfError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public offset: number
  ) {
    super(`[${code}] @${offset}: ${message}`);
    this.name = "RtfError";
  }
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  offset: number;
}
