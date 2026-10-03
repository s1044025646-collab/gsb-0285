import { Store } from "./app/db";
import { RtfService } from "./app/service";
import { createServer } from "./app/http";

const dataDir = process.env.RTF_DATA_DIR ?? "data";
const portArg = process.env.PORT ? Number(process.env.PORT) : 0; // 默认选择空闲端口

const service = new RtfService(new Store(dataDir));
const server = createServer(service);
server.listen(portArg, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : portArg;
  console.log(`RTF 提取服务已启动: http://127.0.0.1:${port}  数据目录: ${service.store.dataDir}`);
});
