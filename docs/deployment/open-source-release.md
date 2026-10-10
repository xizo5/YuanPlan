# 开源维护与发布流程

公共仓库只接受源码、合成测试夹具、通用部署指南及社区文档。不得提交真实实例数据、账号、凭据、数据库导出、私钥、生产地址、SSH 信息或内部恢复记录。

## 提交与验证

提交前执行 `npm run check:release`，变更业务逻辑后执行类型检查、相关测试与构建。完整验证使用 README 中的隔离 Docker CI 命令。默认工作流使用 `pull_request`、读取源码权限及独立测试数据库，不持有部署凭据。

`CODE_OF_CONDUCT.md`、`CONTRIBUTING.md`、`SECURITY.md` 和 Issue / PR 模板用于公共协作。依赖与 Action 更新由 Dependabot 定期提议，经过 CI 验证后再合并。

## GitHub 设置

在发布目标仓库配置：

- main 分支禁止强推和删除；要求 `verify` 状态检查通过及讨论已解决。
- 普通 PR 使用只读 `GITHUB_TOKEN`，不允许工作流自动批准 PR。
- 开启依赖漏洞告警、可用的依赖图与秘密扫描功能。
- 启用 Private vulnerability reporting，并从访客视角核对 SECURITY.md 的报告入口。
- 维护仓库描述、Topics 和版本 Release，注明 MVP 及升级要求。

一人维护时可不强制另一位维护者批准自己的 PR；外部贡献仍需维护者审核。设置适用范围依 GitHub 仓库类型及账户方案而定。

## 首次公开发布

若旧私有仓库曾保存内部运维资料，推荐使用全新仓库发布清理后的源码或经过检查的历史。仅强推新历史不保证清除平台缓存和旧引用。旧仓库应保持私有，不随新仓库开放。参考 [GitHub 敏感数据清理说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)。

不要把旧分支或其他克隆的未清理历史重新合并到公共仓库。源码发布包应由检查通过的提交执行 `git archive` 生成，不能直接压缩整个开发目录。

应用上线由部署方按通用指南配置自己的密钥、HTTPS 和独立备份。公开源码和测试成功并不代替目标环境的邮件、代理、容量与灾难恢复验收。
