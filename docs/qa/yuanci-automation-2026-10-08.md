# YuanCI 自动化脚本本地验收（2026-10-08）

已验证：

- CI 工具镜像 `yuanplan-ci:node22-pg17` 构建成功；Node 22、PostgreSQL 客户端 17.11。
- 在独立 Docker bridge、临时 PostgreSQL、独立工作卷中执行完整流水线。Job 根目录只读、cap-drop ALL、no-new-privileges、2 CPU、4 GiB、512 PID，未挂载 Docker socket 或生产配置。
- npm ci、类型检查、11 个测试文件/97 项测试全部通过，包括真实 pg_dump/pg_restore 恢复测试；前端、API、stdio 构建成功。
- 构建后的 API 健康检查、HTML 首页和 JavaScript 静态资源验证通过；子进程自动退出。
- 发布策略 8 项测试通过：成功 main、最新失败/排队/取消拒绝、错误来源/项目/SHA 拒绝、非 main/非 push 拒绝、无效来源拒绝、配置拒绝、崩溃状态禁止重复、main 移动阻止发布。
- Bash 发布脚本语法检查通过；YuanCI `yuancictl validate` 接受配置，配置哈希 `82895d33e6f2eae706d44bfa4024781a9cda6a5fedf17a9b7ae91a26a25fd3c8`。
- YuanCI gitee/commitstatus/postgres 包测试及 vet 通过。真实临时 PostgreSQL 下，Gitee 共享 Run、状态领取恢复、最终结果事务三项集成测试通过；断言 pending/final 均来自持久化的 push/refs/heads/main。

安装依赖报告 4 项漏洞（2 high、2 critical）；本次未执行 npm audit fix --force。该结果需要后续逐项评估，不能视为安全上线验收通过。

尚未验证：实际 YuanPlan Gitee 仓库接入、Gitee Check Run 来源输出读取、服务器 root 首次安装权限、systemd 实机验证、实际生产备份/跨版本迁移/发布。发布脚本当前只完成静态检查，未在生产运行。线上 Server/Runner 仍需更新。配置示例中的仓库和项目 ID 需要替换，凭据在服务器受保护文件中设置。

测试镜像可保留供后续使用。临时测试容器、网络和工作卷在验收结束后精确清理，不执行全局 prune；生产环境未更改。测试日志保存在 YuanCI 本地忽略目录 `.cache/yuanplan-ci-verification.log`，不包含生产连接串或密钥。
