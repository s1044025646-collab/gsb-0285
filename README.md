# RTF 纯文本提取与诊断后端

本项目是一个 Windows 本地运行的 RTF 纯文本提取服务，提供 HTTP API 与 CLI。
它读取项目内的 RTF 字节文件，输出 UTF-8 文本与结构化解析诊断。
仅做文本子集提取：不还原字体、颜色和版式，不调用 Word，不渲染网页，
不执行也不保存嵌入对象。零第三方运行时依赖（仅使用 Node.js 内置模块与 SQLite）。

## 运行环境

- Windows + Node.js 22+（推荐 24/25，使用内置 `node:sqlite`）
- 不需要 Docker / WSL / 付费服务 / 外部在线 API

## 快速开始

```powershell
npm install        # 安装开发依赖（typescript）
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo       # 端到端演示：构造样例 -> 导入 -> 提取 -> 导出
```

端口配置：`$env:PORT=8080; npm start`，或 `npm run cli -- serve --port 8080`。
不传端口时自动选择空闲端口并打印实际地址。

数据目录：默认 `data/`（可用环境变量 `RTF_DATA_DIR` 覆盖），包含
`rtf.db`（SQLite）、`files/`（导入文件的只读副本）、`exports/`（导出结果）。
提取过程绝不修改源文件；重启后可用 `history` / `diag` / `state` 复查历史结果。

## CLI

```
node dist/src/cli.js import <file.rtf>        # 导入（计算 SHA-256，复制只读副本）
node dist/src/cli.js extract <documentId>     # 提取并打印 UTF-8 文本与诊断
node dist/src/cli.js diag <documentId>        # 最近一次提取的诊断
node dist/src/cli.js state <documentId>       # 关键控制状态（uc/代码页/跳过目的地等）
node dist/src/cli.js history <documentId>     # 提取历史
node dist/src/cli.js export <extractionId> <txt|json>
node dist/src/cli.js list                     # 已导入文档
node dist/src/cli.js serve [--port N]         # 启动 API
node dist/src/cli.js demo                     # 演示
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/documents` | 导入，body: `{"path": "samples/demo.rtf"}` |
| GET | `/documents` / `/documents/:id` | 文档列表 / 详情（含 SHA-256、副本位置） |
| POST | `/documents/:id/extract` | 执行提取，返回文本、诊断、状态 |
| GET | `/documents/:id/extractions` | 提取历史 |
| GET | `/documents/:id/diagnostics` | 最近一次提取的诊断 |
| GET | `/documents/:id/state` | 关键控制状态摘要 |
| GET | `/extractions/:id` | 单条提取结果 |
| GET | `/extractions/:id/export?format=txt\|json` | 导出到 `data/exports/` 并返回内容 |

错误响应统一为 `{"error": {"code": "...", "message": "..."}}`，
参数校验错误码如 `E_BAD_PARAM`、`E_DOC_NOT_FOUND`、`E_EXTRACTION_FAILED`。

## 支持的 RTF 子集

- 文件必须以 `{\rtf1` 开头，否则 `E_NOT_RTF`
- 仅支持 `\ansi` + `\ansicpg1252`（Windows-1252）；其他代码页（如 936）返回
  `E_UNSUPPORTED_CODEPAGE`，绝不按终端当前编码猜测源字节
- 花括号分组与反斜杠控制词由自研字节级解析器处理，用栈保存/恢复组状态
  （是否忽略当前目的地、`\uc` 回退字符数）
- 文本输出：普通字节（按 Windows-1252 解码）、`\'hh` 十六进制字节转义、
  转义的 `\\` `\{` `\}`、`\~` `\_`、`\emdash` 等少量符号控制词
- 换行与制表：仅 `\par` `\line` `\sect` 输出 `\n`，`\tab` 输出 `\t`；
  源文件排版用的 CR/LF 一律不进入正文；控制词后的单个分隔空格被消费
- Unicode：`\uN`（有符号 16 位，负数加 65536 补偿），合法代理对组合为
  单个码点；`\ucN` 设定回退字符数，仅在当前组及子组生效，退组恢复；
  回退按“字符”计数——一个控制词或一个 `\'hh` 转义字节各算 1 个字符
- 可忽略的基本样式控制词：`\b \i \ul \fs \f \cf \pard \plain \lang` 等
- 整组跳过的目的地：`fonttbl colortbl stylesheet info pict object` 等，
  以及任何带 `\*` 标记的未知目的地；忽略组内的嵌套结构仍被完整扫描，
  嵌套组不会意外重新开启正文输出
- 未知普通格式控制词：忽略并记录 `W_UNKNOWN_CONTROL` 警告，其参数不进入正文

## 字符口径

- 输入：原始字节流（`Buffer`），不做任何编码猜测
- 输出：始终为 UTF-8（API 响应、CLI 输出、导出文件均为 UTF-8）
- 同一文件在任何终端环境下得到完全一致的 UTF-8 字节（有测试保证）

## 明确不支持的结构（返回诊断而非乱码）

| 结构 | 错误码 |
| --- | --- |
| 原始二进制载荷 `\bin` | `E_UNSUPPORTED_BIN` |
| 复杂域指令 `\field`/`\fldinst` | `E_UNSUPPORTED_FIELD` |
| 替代 Unicode 目的地 `\upr` | `E_UNSUPPORTED_UPR` |
| 非 1252 代码页 / `\mac` 等 | `E_UNSUPPORTED_CODEPAGE` |
| 不完整或孤立的代理对 | `E_INCOMPLETE_SURROGATE` |
| 花括号不配对 | `E_UNBALANCED_BRACES`（含字节偏移） |
| 非法十六进制转义 | `E_BAD_HEX_ESCAPE`（含字节偏移） |
| 参数缺失或超限 | `E_BAD_PARAM`（含字节偏移） |

提取结果 `status` 三态：`ok` / `ok_with_warnings` / `failed`。
失败记录与完整输出明确区分：失败时 `text` 为 `null`，且不可导出正文。

## 数据库

SQLite（`data/rtf.db`）两张表：

- `documents`：文件名、SHA-256 摘要、大小、源路径、只读副本位置、导入时间
- `extractions`：文档外键、规则版本（`rtf-text-rules/1.0.0`）、状态、
  文本、诊断 JSON、控制状态 JSON、创建时间

## 目录结构

```
src/rtf/parser.ts    字节级 RTF 解析器（分组栈、控制词分派、Unicode 回退）
src/rtf/cp1252.ts    Windows-1252 映射表
src/rtf/errors.ts    错误码与诊断类型
src/app/db.ts        SQLite 存储层
src/app/service.ts   业务服务（导入/提取/导出）
src/app/http.ts      HTTP API 路由
src/server.ts        服务入口
src/cli.ts           CLI 入口
test/                node:test 测试（解析器 + 服务 + API）
```
