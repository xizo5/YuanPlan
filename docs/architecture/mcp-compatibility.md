# MCP 接入路线与兼容验收

更新日期：2026-09-20。首发目标客户端：Claude Desktop 与 Codex。

本文区分官方配置依据、服务端测试及实际产品验收。已验证本机 Codex app-server 运行时的 HTTP/stdio 接入；Claude Desktop 及桌面界面操作尚未完成验收。配置和复现步骤见[客户端接入指南](../user/mcp-clients.md)。

## 当前服务契约

- 地址：实例地址下的 `/api/mcp`。
- 传输：Streamable HTTP；无服务端会话 ID，响应使用 JSON。
- SDK：`@modelcontextprotocol/sdk` 1.30.0，具体锁定版本见仓库锁文件。
- 认证：`Authorization: Bearer <项目范围凭据>`，每次请求重新检查用户、凭据与项目权限。
- 已提供 `packages/mcp-stdio` 本地桥接，仅转发工具枚举及调用；当前没有 OAuth 授权服务。
- 若客户端发送 `Origin`，必须与实例 `APP_URL` 的源一致。

## Codex

官方文档提供 Streamable HTTP 的 `url`、`bearer_token_env_var` 及认证头配置，适合先验证当前项目范围凭据路线。参见 [OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

候选 `config.toml` 片段：

```toml
[mcp_servers.yuanplan]
url = "http://localhost:5173/api/mcp"
bearer_token_env_var = "YUANPLAN_MCP_TOKEN"
```

部署后将 URL 替换为实际 HTTPS 地址；开发环境需启动 Vite 和 API。将项目范围凭据放在启动客户端进程可读取的 `YUANPLAN_MCP_TOKEN` 环境变量中，不将明文写入仓库。终端中的环境变量不一定由已运行的桌面进程继承。

本机 `codex-cli 0.155.0-alpha.9.2` 的 app-server 返回 `Codex Desktop/0.155.0-alpha.9.2 (Windows 10.0.26100; x86_64)`。已通过实际运行时的认证握手、18 个工具枚举、项目范围、只读拒绝、任务读写、版本冲突、幂等、Wiki 往返、MCP 审计与撤销；构建后的 stdio 桥接读写及撤销也通过。HTTP 直连观测协议版本为 `2025-06-18`，加入 SDK 桥接后还观测到上游 `2025-11-25`。

验证通过 app-server 协议执行，不启动模型回合，不代表桌面界面手工验收。可执行 `npm run test:codex-mcp` 复现；脚本使用隔离临时配置和不持久化的协议上下文，结束撤销临时项目凭据。本轮未更改用户全局 Codex 配置。

## Claude Desktop

Claude 的远程自定义连接器从 Anthropic 云端连接服务器；本机 `localhost` 地址不能直接用于该路线。官方文档描述了 OAuth 配置，但没有据此确认当前 YuanPlan 静态 Bearer 凭据可直接用于该入口。参见 [Claude 远程连接器说明](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)。

本地桌面扩展是另一种接入机制，可访问本机网络；官方提供扩展安装与敏感配置存储机制。参见 [Claude Desktop 本地 MCP 说明](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)。

据此，已实现本地 stdio → Streamable HTTP 桥接，保留现有项目范围凭据与服务端授权。另一条路线是公网 HTTPS + OAuth，涉及新的授权服务与部署范围，应单独设计。桥接已通过 SDK 子进程及 Codex 实际运行时验证，Claude Desktop 配置示例仍需实际产品验收。

本轮未检测到正在运行的 Claude Desktop，也未取得它的实际版本；本机 Claude CLI 不能替代 Desktop 验收。

## 验收矩阵

| 场景 | 服务端自动化 | Codex 实际客户端 | Claude Desktop 实际客户端 |
| --- | --- | --- | --- |
| 认证握手、工具枚举与调用 | SDK / HTTP / stdio 测试通过 | 实际运行时通过 | 待验证 |
| 项目白名单、只读凭据拒绝写入 | 集成及 stdio 测试通过 | 实际运行时通过 | 待验证 |
| 任务与 Wiki 写入、版本冲突和幂等 | 集成及 stdio 测试通过 | 实际运行时通过 | 待验证 |
| 撤销、到期与权限变化后的新请求 | 已有集成测试；stdio 撤销通过 | 撤销通过；到期和角色变化待客户端验证 | 待验证 |
| 真实 HTTP 响应丢失后的重试 | 2026-09-20 新增测试通过 | 待验证 | 待验证 |
| API 中断与重启后的事务一致性 | 2026-09-20 新增测试通过 | 待验证 | 待验证 |

每个实际客户端需记录：产品版本、操作系统、传输及认证配置（脱敏）、协商协议版本、工具枚举、一次受控读写、只读拒绝、版本冲突、撤销后新调用，以及数据库中的操作人/凭据/来源审计。记录完成后再更新 T03/T27 状态。

本轮总验证：60 项集成测试、类型检查及前端/后端/桥接构建通过；构建后的纯 Node 桥接另通过 7 项同链路用例。T03/T27 仍保留 Claude Desktop 和剩余真实客户端场景，不标记为全部完成。
