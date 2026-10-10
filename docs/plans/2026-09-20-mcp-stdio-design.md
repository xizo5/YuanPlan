# MCP 本地桥接设计与实现计划

日期：2026-09-20。依据：V1 T03/T27/T28、已选定的 Claude Desktop + Codex，以及接入路线文档。

## 方案

采用仓库内的独立 `@yuanplan/mcp-stdio` workspace，使用现有锁定版本的官方 MCP SDK。桌面客户端通过 stdio 与桥接通信，桥接作为 HTTP 客户端访问既有 `/api/mcp`。仅提供 tools 能力：枚举及调用都实时转发，不复制业务服务或缓存授权结论。

替代方案是第三方代理或新增公网 OAuth 服务。前者增加独立依赖与版本验证，后者涉及新的授权与部署范围。本轮选择小范围仓库内桥接，Codex 仍可直接连接 HTTP。

## 配置与生命周期

- 必填 `YUANPLAN_MCP_URL` 和 `YUANPLAN_MCP_TOKEN`，仅从进程环境读取，不自动加载仓库 `.env`。
- 允许 HTTPS；明文 HTTP 仅用于 localhost、127.0.0.1 与 ::1。拒绝 URL 内嵌账号、查询参数、片段及 HTTP 重定向，避免把凭据送到非预期地址。
- stdout 仅承载 MCP 协议，诊断只写 stderr 且不输出凭据、上游响应体或原始异常。
- 上游启动失败时以非零状态退出；调用超时或认证失效返回明确协议错误。业务工具结果及其 `isError` 保持原样。
- 转发取消信号，设置请求超时；客户端关闭 stdin 或终止进程时关闭两端传输。桥接不自动重放写入。

## 实现顺序

1. 建立桥接 workspace 与构建入口，纳入根构建及锁文件。
2. 实现配置验证、SDK stdio/HTTP 转发及进程收尾。
3. 使用独立 PostgreSQL 测试库启动真实 HTTP 服务，通过真实 stdio 子进程测试握手、工具 schema、项目范围、只读拒绝、写入版本/审计、冲突与幂等、撤销后的请求。
4. 验证配置失败、重定向、stdout 洁净与 stdin 关闭；运行类型检查、全量集成测试和构建。
5. 提供 Claude Desktop 与 Codex 配置示例，并将自动化链路验证与实际产品验收分开记录。

## 验收边界

桥接不增加 OAuth、resources、prompts、sampling 或后台任务能力。客户端授权用户、项目范围和操作来源完全由现有服务端判定。本地 SDK 客户端通过不等于 Claude Desktop 或 Codex 的实际产品验收；缺失客户端环境时保留待验收状态。

## 实施结果

- 7 项新桥接测试通过，全量集成测试 60 项通过；类型检查与前端/后端/桥接构建通过。
- 构建后的 `dist/index.js` 以纯 Node 启动，另通过同一组 7 项用例。
- 本机 Codex app-server 实际运行时通过 HTTP 认证、18 项工具发现、项目范围、只读拒绝、任务读写、幂等、冲突、Wiki、审计与撤销；其 stdio 路线也通过构建产物的读写与撤销。
- 验证脚本为 `npm run test:codex-mcp`，不启动模型回合、不写用户全局配置，使用不持久化的协议上下文，结束时撤销临时凭据。
- Claude Desktop 实测与桌面界面人工验收仍保留。详细证据见[兼容记录](../architecture/mcp-compatibility.md)。
