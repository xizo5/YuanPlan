# MCP 客户端接入

YuanPlan 支持通过 Streamable HTTP 提供任务和 Wiki 工具，并提供本地 stdio 桥接供桌面客户端使用。当前已验证 Codex 的实际 app-server 运行时及官方 SDK stdio 链路；Claude Desktop 的界面接入仍待实测，以下 Claude 配置是待验收示例。

## 准备

1. 按根目录 README 安装、迁移并启动实例。
2. 登录“AI 与集成”，创建项目范围凭据。默认凭据只能访问你在创建时勾选的项目；勾选“覆盖全部项目”后，凭据可访问你所属的任意项目（含以后新建的项目），但仍以你在该项目的成员身份为上限，且不能执行项目级管理操作。先用只读范围验证，再按实际需要创建写入凭据。
3. 记录实例的 `/api/mcp` 地址。默认开发 API 地址是 `http://127.0.0.1:18420/api/mcp`，前端代理地址也可使用；修改了 `PORT` 时同步调整。

凭据完整内容只显示一次。不要使用登录密码、`AUTH_SECRET` 或 `SETUP_TOKEN` 代替。远程连接使用 HTTPS；本地桥接仅对 localhost、127.0.0.1 和 ::1 允许 HTTP。

## Codex：直接 HTTP

在 Codex 的 MCP 配置中添加：

```toml
[mcp_servers.yuanplan]
url = "http://127.0.0.1:18420/api/mcp"
bearer_token_env_var = "YUANPLAN_MCP_TOKEN"
```

让启动 Codex 的进程环境包含 `YUANPLAN_MCP_TOKEN`。例如，在已配置该变量的终端启动 Codex；已经运行的桌面进程通常不会继承后来在终端设置的变量。不要将真实凭据提交到项目配置中。

`url` 与 `bearer_token_env_var` 是官方支持的配置字段，参见 [OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## Claude Desktop：本地 stdio 桥接

先在仓库根目录构建：

```bash
npm ci
npm run build
```

在 Claude Desktop 的开发者 MCP 配置中，将以下条目合并进现有 `mcpServers`，保留其他服务器配置：

```json
{
  "mcpServers": {
    "yuanplan": {
      "command": "node",
      "args": ["C:/path/to/YuanPlan/packages/mcp-stdio/dist/index.js"],
      "env": {
        "YUANPLAN_MCP_URL": "http://127.0.0.1:18420/api/mcp",
        "YUANPLAN_MCP_TOKEN": "REPLACE_WITH_PROJECT_CREDENTIAL"
      }
    }
  }
}
```

替换仓库路径和凭据。macOS 使用对应的绝对路径；若桌面程序找不到 Node，将 `command` 改为 Node 可执行文件的绝对路径。保留已安装的依赖目录，桥接构建产物依赖 MCP SDK，不能单独复制一个 JS 文件使用。

客户端应直接启动 `node .../dist/index.js`，不要通过会向 stdout 打印脚本标题的 `npm run` 启动。桥接不会自动加载 `.env`，也不要求在仓库目录启动。

配置文件包含敏感凭据，应保存在客户端本地配置中，不放入仓库。完全退出并重启 Claude Desktop 后检查工具列表。配置入口和文件位置参见 [MCP 官方 Claude Desktop 本地接入指南](https://modelcontextprotocol.io/docs/develop/connect-local-servers)。本轮尚未完成该客户端实际重启、界面发现和调用验收。

Claude 的远程自定义连接器与本地 stdio 配置是不同入口：前者从云端连接，不能直接连接本机回环地址。当前 YuanPlan 未提供 OAuth，不能把上述项目令牌配置视为 OAuth 接入。参见 [Claude 远程 MCP 说明](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)。

## Codex：可选 stdio 路线

Codex 也可以使用同一桥接。HTTP 直连与 stdio 二选一即可：

```toml
[mcp_servers.yuanplan]
command = "node"
args = ["C:/path/to/YuanPlan/packages/mcp-stdio/dist/index.js"]
env_vars = ["YUANPLAN_MCP_URL", "YUANPLAN_MCP_TOKEN"]
```

这两个环境变量必须由启动进程提供。该路线已经用本机 Codex 运行时验证读写及凭据撤销。

## 首次验证

在专用测试项目内依次检查：

1. 枚举工具并调用 `list_projects`，只返回凭据授权的项目。
2. 使用只读凭据创建任务，应拒绝写入。
3. 换用写入凭据创建任务，再从网页确认内容与 MCP 来源审计。
4. 更新前读取当前版本；版本冲突时重新读取，不直接覆盖。
5. 撤销凭据后继续使用原连接调用，必须拒绝。

写入工具的 `operationId` 需要客户端生成 UUID。同一逻辑操作重试沿用同一 ID 和参数，新操作使用新 ID。网络中断不意味着未保存，先读取状态；桥接不会自动重放写入。

## 开发者复现

使用专用 `_test` 数据库并运行：

```bash
npm test -- tests/mcp-stdio.test.ts
npm run build
npm run test:codex-mcp
```

最后一条命令要求本机 `codex` 可执行文件可用，可用 `CODEX_BIN` 指定路径。它使用隔离的临时 Codex 配置和不持久化的协议上下文，不启动模型回合，不修改用户全局配置。会创建测试项目及十分钟有效期的临时凭据，结束时撤销凭据；报告存入被忽略的 `.data/codex-mcp-*/report.json`。脚本依赖当前 Codex app-server 实验协议，版本升级后需重新验证。

## 排错

- **Cannot start**：检查两个桥接环境变量、Node 路径、实例连通性及凭据有效期。
- **YuanPlan request failed**：检查服务器是否可用、凭据是否已撤销及账号状态。业务工具错误还会返回 `isError` 和具体业务错误码。
- **重定向失败**：使用最终 MCP 地址，桥接不会跟随 HTTP 重定向。
- **工具显示但不能修改**：检查凭据的读写范围、项目角色和归档状态；网页权限与 MCP 权限共同限制操作。
