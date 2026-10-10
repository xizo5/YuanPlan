# 可选 YuanCI 自动验收与发布

默认公共协作检查使用 GitHub Actions，配置见 `.github/workflows/ci.yml`。本指南描述可选的 Gitee / YuanCI 集成，不需要此功能时无需部署。

## 验收工具镜像

```sh
docker build -f deploy/automation/Dockerfile.ci -t yuanplan-ci:node22-pg17 .
docker build --target database -t yuanplan-db:pg17 .
```

把两个镜像提供给自己的 Runner，并配置 `.yuanci.yml`。每次任务使用独立数据库，不提供生产配置。GitHub 和本地完整验证可直接执行：

```sh
docker compose -f compose.ci.yaml -p yuanplan-ci-local run --build --rm verify
docker compose -f compose.ci.yaml -p yuanplan-ci-local down --volumes
```

此 CI 配置只创建可丢弃测试服务，不与正式 Compose 项目共享数据卷。

## 发布服务要求

仅当自己的 Gitee main 当前提交具有最新匹配的 YuanCI push 成功结果时，发布器允许发布。分支、来源、项目 ID 和 SHA 必须一致。来源标记不是数字签名，具有仓库 Check Run 写权限的主体属于发布信任边界。

部署方自行准备 Linux、Python 3.10+、Bash、Git、OpenSSH、curl、flock、Docker Engine / Compose v2，以及已经初始化且健康的应用和数据库。脚本使用普通 `compose.yaml`；`compose.server.yaml` 为可选的部署覆盖文件。生产配置只存放在部署主机，不进入仓库。

以下目录是示例默认值，可按自己的环境修改。先将 `deploy/automation/` 放到受控暂存目录，并用具备对应权限的账号执行：

```sh
install -d -m 700 /etc/yuanplan-release /var/lib/yuanplan-release /usr/local/lib/yuanplan-release
install -m 700 deploy/automation/publisher.py /usr/local/lib/yuanplan-release/publisher.py
install -m 700 deploy/automation/release.sh /usr/local/lib/yuanplan-release/release.sh
install -m 600 deploy/automation/public_health_url.py /usr/local/lib/yuanplan-release/public_health_url.py
install -m 600 deploy/automation/config.example.json /etc/yuanplan-release/config.json
install -m 644 deploy/automation/yuanplan-publish.service /etc/systemd/system/
install -m 644 deploy/automation/yuanplan-publish.timer /etc/systemd/system/
```

在受保护编辑器中配置自己的 repository、HTTPS YuanCI 地址、非零项目 UUID、部署目录和令牌文件。示例值不能直接启用。令牌只需读取目标仓库 main 与 Check Runs；Git 使用只读 Deploy Key。核实主机密钥并启用严格检查，不把凭据写入命令行、代码或日志。

```sh
python3 /usr/local/lib/yuanplan-release/publisher.py --config /etc/yuanplan-release/config.json --check-config
bash -n /usr/local/lib/yuanplan-release/release.sh
systemd-analyze verify /etc/systemd/system/yuanplan-publish.service /etc/systemd/system/yuanplan-publish.timer
systemctl daemon-reload
```

`--check-config` 只校验结构，不调用 API 或发布。核对当前 main 成功结果、来源标记、配置、磁盘空间和独立备份后再启用 timer：

```sh
systemctl enable --now yuanplan-publish.timer
journalctl -u yuanplan-publish.service -n 100 --no-pager
```

timer 可能立即部署符合条件的提交。部署前应在自己的预发布环境验证完整流程。

## 发布与故障处理

发布器按提交构建应用镜像，开启维护并停止旧应用，生成一致备份，再迁移、重建应用及验证健康。公网检查读取 Compose 中的 `APP_URL`，要求 HTTPS 且无 URL 内凭据、查询或 fragment；不会使用任何预设网站。Compose 项目名默认 `yuanplan`，如已有项目名不同，可在发布服务环境配置 `YUANPLAN_COMPOSE_PROJECT`。

脚本保留旧镜像、配置、数据库和附件备份及日志，失败时不会自动关闭维护、恢复数据库或重复执行同一提交。这些文件包含敏感数据，只放在部署主机受控目录，并纳入独立加密备份与容量管理。

```sh
systemctl stop yuanplan-publish.timer
journalctl -u yuanplan-publish.service -n 100 --no-pager
```

处理失败时先核对维护状态、迁移和日志。回退使用匹配代码/镜像和一致备份恢复到空环境，不能只换旧镜像。管理员确认可安全重试后，才归档对应 SHA 的失败状态并恢复 timer。

通用安装与恢复见[容器部署与备份](docker-and-backup.md)。公开项目不提供任何实例的 SSH 地址、账号、部署配置、备份定位或内部恢复手册。
