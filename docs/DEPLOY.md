# 部署

## 本机一条命令

需要 Node.js 24+；首次检出先在仓库根目录运行 `npm ci`，之后启动只需：

```sh
npm run wispiva
```

命令先构建网页，再启动引擎，打印 `http://127.0.0.1:8787`。在浏览器打开该地址；按 Ctrl+C 停止，世界随进程退出冻结，重启不补算离线时间。

SQLite 与配置默认保存在仓库的 `.data/wispiva/`。模型配置写入其中的 `config.json`；未配置 API key 时，沿用 `GROQ_LLM_API_KEY` 环境变量回退，例如 `GROQ_LLM_API_KEY=你的密钥 npm run wispiva`。已有配置优先，密钥不通过 API 返回。也可用 `WISPIVA_DATA_DIR` 指定数据目录。

若只运行 `npm run start --workspace=@wispiva/engine`，需事先构建网页；缺少 `packages/web/dist/index.html` 时入口会提示构建命令并退出。

## 云自托管

部署同一份代码，安装 Node.js 24+ 并运行 `npm ci`、`npm run wispiva`。由进程管理器托管单个 Node 服务，支持 SIGINT/SIGTERM 优雅关闭。构建完成后的日常重启可直接用 `npm run start --workspace=@wispiva/engine`，保留开发依赖中的 TS 运行器。

将持久卷挂到仓库的 `.data/`，保存 `.data/wispiva/wispiva.db` 与 `config.json`；容器中也可把卷挂到 `/data` 并设置 `WISPIVA_DATA_DIR=/data/wispiva`。卷须允许服务用户读写；备份前停止进程，并备份整个数据目录。进程停止、崩溃或重启期间世界冻结，不进行离线追算。

引擎仅监听 `127.0.0.1:8787`。在同一主机或共享网络命名空间中配置 HTTPS 反向代理，转发网页与 `/api/`；SSE 的 `/api/events` 要关闭代理缓冲并允许长连接。例如 Nginx 的站点内：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_buffering off;
    proxy_read_timeout 1d;
}
```

v1 为单用户服务，公网访问请在反向代理层限制访问或加鉴权。服务端只推进世界事实并调用配置的远程 LLM；3D 在观看端浏览器渲染，云主机无需 GPU、CUDA 或本地模型权重。
