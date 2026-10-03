# RTF 纯文本提取与诊断后端

本地运行的 RTF 纯文本提取服务：读取项目内 RTF 字节文件，输出 UTF-8 文本与解析诊断。
仅 API 与 CLI，无界面；不调用 Word、不渲染网页、不执行或保存嵌入对象。

- 技术栈：TypeScript + Node.js（>= 22.5，使用内置 `node:sqlite`）+ SQLite
- 纯 Node 标准库 HTTP 服务，无运行时第三方依赖
- 规则版本：`rtf-text-1.0.0`（每次提取随结果入库）

## 快速开始

```powershell
npm install        # 安装 devDependencies（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API 服务（默认自动选择空闲端口）
npm run demo       # 端到端演示：导入示例 RTF、提取、导出 TXT/JSON
```

端口配置：`node dist/src/cli.js serve --port 8080` 或环境变量 `PORT`；不传时端口为 0（系统自动分配空闲端口）。
数据目录：默认 `./data`（含 `rtf.db` 与只读副本 `data/files/`），可用 `RTF_DATA_DIR` 覆盖。

## CLI

```
node dist/src/cli.js serve [--port N]           启动 API 服务
node dist/src/cli.js import <file.rtf>          导入（计算 SHA-256，复制只读副本，不改源文件）
node dist/src/cli.js extract <documentId>       执行提取并入库
node dist/src/cli.js text <documentId>          输出最近提取的 UTF-8 纯文本
node dist/src/cli.js diagnostics <documentId>   查看诊断（与失败报告）
node dist/src/cli.js state <documentId>         查看关键控制状态（代码页/uc/跳过目的地/未知控制词）
node dist/src/cli.js list                       列出已导入文档
node dist/src/cli.js export <extractionId> <txt|json> <outFile>   导出结果
```

## API（默认监听 127.0.0.1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/documents` | 导入，body `{"path": "x.rtf"}` |
| GET | `/api/documents` / `/api/documents/:id` | 文档列表 / 详情 |
| POST | `/api/documents/:id/extract` | 执行提取，结果入库 |
| GET | `/api/documents/:id/extractions` / `/extractions/latest` | 历史 / 最近一次 |
| GET | `/api/documents/:id/text` | 最近提取的纯文本（text/plain; charset=utf-8） |
| GET | `/api/documents/:id/diagnostics` | 诊断与失败报告 |
| GET | `/api/documents/:id/state` | 关键控制状态 |
| GET | `/api/extractions/:id` | 提取记录详情 |
| GET | `/api/extractions/:id/export?format=txt\|json` | 导出 TXT / JSON |

错误响应统一为 `{"error": {"code": "...", "message": "..."}}`，HTTP 状态码区分 400/404/409/500。

## 支持列表

- 分组 `{ }` 与状态栈：忽略目的地标志、`\uc` 回退字符数随组保存/恢复
- 控制词与分隔空格、转义 `\\` `\{` `\}`、`\'hh` 十六进制字节转义
- `\par` `\line`（输出 `\n`）、`\tab`（输出 `\t`）；源文件排版用 CR/LF 不进入文本
- `\ucN`（0–10，组内生效）、`\uN`（有符号 16 位，负数 +65536 补偿）
- 合法代理对组合为单个码点；`\emdash` `\endash` 引号 `\bullet` 等常见符号
- 可忽略基本样式控制词（`\b` `\i` `\fs` `\f` `\cf` 等），参数不进入正文
- 非正文目的地整组跳过：`fonttbl` `colortbl` `stylesheet` `info` `pict` `object` 等，
  以及 `\*` 标记的未知目的地；忽略组内嵌套结构仍被完整扫描
- 未知普通格式控制词：忽略并记录诊断，不当作正文

## 字符口径

- 输入为字节流；仅支持 `\ansi` + `\ansicpg1252`（Windows-1252），其他代码页明确拒绝
  （`RTF_UNSUPPORTED_CODEPAGE`），绝不按当前终端/PowerShell 编码猜测源字节
- `\'hh` 按 Windows-1252 单字节解码（含 0x80–0x9F 特殊映射，如 `\'80` → €）
- 中文等非西欧字符通过 `\uN` Unicode 控制词表达；`\uN` 后的回退字符按当前组 `uc`
  数量跳过，`\'hh` 转义字节整体计为一个回退字符（不按源码长度）
- 输出统一为 UTF-8 文本，与终端代码页无关（demo 输出十六进制字节可验证一致性）

## 明确不支持（返回诊断错误）

- `\bin` 原始二进制载荷（`RTF_UNSUPPORTED_BIN`）
- `\field` 复杂域指令（`RTF_UNSUPPORTED_FIELD`）
- `\upr` 替代 Unicode 目的地（`RTF_UNSUPPORTED_UPR`）
- 不完整/孤立代理对（`RTF_INCOMPLETE_SURROGATE`，不输出乱码冒充成功）
- 非 1252 代码页、非法 RTF 头、花括号不配对、非法十六进制转义、
  `\u`/`\uc` 参数缺失或超限——均带原始字节偏移定位

## 存储与复查

SQLite（`data/rtf.db`）保存：文档（名称、SHA-256、源路径、只读副本路径、大小、导入时间）
与提取记录（规则版本、状态 ok/failed、文本、诊断 JSON、控制状态、错误 JSON、时间）。
失败报告与完整输出明确区分；服务重启后可通过 `extractions` 接口复查历史。

## 错误码一览

`RTF_INVALID_HEADER` `RTF_UNBALANCED_BRACE` `RTF_BAD_HEX` `RTF_BAD_ESCAPE`
`RTF_BAD_PARAM` `RTF_UNSUPPORTED_CODEPAGE` `RTF_UNSUPPORTED_BIN`
`RTF_UNSUPPORTED_FIELD` `RTF_UNSUPPORTED_UPR` `RTF_INCOMPLETE_SURROGATE`
`FILE_NOT_FOUND` `EMPTY_FILE` `NOT_FOUND` `BAD_REQUEST` `BAD_JSON`
`EXTRACTION_FAILED` `INTERNAL`

## 限制

- 不还原字体、颜色、版式；不处理表格/图片/嵌入对象的语义内容
- `\u` 代理对要求高、低代理连续出现（各自可带回退字符）
- `node:sqlite` 在 Node 25 仍为实验特性（启动时有 ExperimentalWarning，不影响功能）
