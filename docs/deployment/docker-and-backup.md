# 容器部署、升级与一致备份

当前应用版本：0.1.0；数据库迁移：0001–0009。适用于 Docker Engine 和 Docker Compose v2，数据库使用 PostgreSQL 17 / Alpine 3.24。应用镜像包含生产静态资源、API、MCP、迁移程序和 PostgreSQL 备份客户端，不依赖开发服务器。

应用与数据库镜像均由仓库 Dockerfile 构建；数据库阶段保留官方入口及初始化流程，将用户切换辅助程序替换为 Alpine 维护的 `su-exec`，并更新系统包。构建需访问官方镜像与 Alpine 包仓库。

## 首次安装

在仓库根目录执行：

```sh
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env，替换全部占位值
docker compose --env-file deploy/.env build
docker compose --env-file deploy/.env up -d app
docker compose --env-file deploy/.env ps -a
```

Windows PowerShell 可用 `Copy-Item deploy/.env.example deploy/.env`。每个密钥、密码应独立生成，例如用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成 64 位十六进制值。数据库密码使用十六进制可避免连接 URL 的转义问题。不要把实际配置提交到 Git。

`db` 健康后，`migrate` 执行迁移和运行账号授权；仅当迁移退出码为 0 时启动 `app`。检查 `migrate` 的退出状态及 `app` 的健康状态。`docker compose up -d` 返回时应用可能仍在启动，请等待健康检查成功再验证业务接口。

应用默认绑定宿主机 `127.0.0.1:18420`。配置宿主机反向代理终止 HTTPS，将请求转发到该地址，保留 Host，并转发协议头；MCP 路由应允许流式响应。把 `APP_URL` 改为用户访问的 HTTPS 地址。生产认证使用安全 Cookie，普通 HTTP 不能作为完整登录验收环境。TLS 证书与代理由部署方管理，本配置不自动签发证书。

首次访问后用 `SETUP_TOKEN` 创建实例管理员。SMTP 配置可选；未配置时使用产品提供的邀请与受控账号恢复流程。真实邮件投递需单独验收。

## 数据与数据库权限

| 服务/卷 | 用途 |
| --- | --- |
| `app` | 非 root 运行，使用 `yuanplan_app` 数据库角色 |
| `migrate`、`ops` | 使用拥有业务表的 `yuanplan_migrator` 角色 |
| `database` | PostgreSQL 数据目录 |
| `uploads` | 不可变附件对象，包含历史版本引用的文件 |
| `backups` | 运维备份暂存，须另行导出到独立存储 |

运行账号不拥有业务表，不能在 public 建表，也不能修改、删除或清空审计和版本表。每次迁移及恢复后执行 `deploy/migrate.mjs` 重新授予权限。PostgreSQL 不对宿主机开放端口。

初始化角色的脚本只在数据库卷为空时执行。修改环境文件中的数据库密码不会自动修改已有角色密码；轮换时须同步修改数据库角色及配置。Compose 项目名影响卷名，应固定使用同一个项目名。重建容器保留命名卷，`down --volumes` 会删除数据，不应作为日常重启命令。

## 一致备份

先开启维护模式，再生成全新目录：

```sh
docker compose --env-file deploy/.env run --rm ops node apps/server/dist/cli.js maintenance --state on
docker compose --env-file deploy/.env run --name yuanplan-backup-export ops node apps/server/dist/cli.js backup --output /backups/backup-20260920
mkdir -p .data
docker cp yuanplan-backup-export:/backups/backup-20260920 .data/backup-20260920
docker rm -v yuanplan-backup-export
docker compose --env-file deploy/.env run --rm ops node apps/server/dist/cli.js maintenance --state off
```

每次替换目录名，确认命令成功及导出完成后再关闭维护。失败后维护模式也保持开启；没有 `manifest.json` 的目录视为不完整备份，不能用于恢复。不会覆盖已有备份目录。运维输出包含主机、操作系统用户及时间，可保存到受控运维日志。

维护模式下除健康检查外的 API 返回 503 和 `Retry-After: 60`。备份持有迁移锁及附件维护锁，数据库清单与 `pg_dump` 使用同一导出快照；附件按数据库登记复制并校验 SHA-256，包括已从当前正文移除、仍供历史使用的文件。未登记孤立对象不纳入备份。所有写入进程必须采用当前协议，备份期间不要手工修改附件或运行外部 SQL 写入。

备份包含 `database.dump`、`uploads/` 和 `manifest.json`（应用版本、迁移校验、文件大小及哈希）。另行安全保存原 `AUTH_SECRET`、部署配置、所用代码提交/镜像标识及代理配置。备份不保存密钥明文；恢复要求相同 `AUTH_SECRET`，缺失或不一致时拒绝恢复。数据库仍含个人数据及凭据相关信息，应限制导出目录访问权限，并在独立存储中加密保存。单机命名卷不能替代异地备份。

## 恢复到新环境

使用匹配备份版本的代码/镜像、新 Compose 项目名和全新数据卷。以下示例环境文件为 `deploy/.env.restore`，保留原 `AUTH_SECRET`，配置新的访问地址和数据库密码，并额外设置：

```dotenv
RESTORE_DATABASE_URL=postgresql://yuanplan_migrator:<新的迁移账号密码>@db:5432/yuanplan
```

以下命令中的 `yuanplan-restored` 是新实例项目名：

```sh
# 只启动数据库并准备备份卷，不运行迁移或应用
docker compose --env-file deploy/.env.restore -p yuanplan-restored run --name yuanplan-backup-import ops node -e "process.exit(0)"
docker cp .data/backup-20260920 yuanplan-backup-import:/backups/backup-20260920
# 导入文件默认可能归 root，交给运维容器用户读取
docker compose --env-file deploy/.env.restore -p yuanplan-restored run --rm --user root ops chown -R postgres:postgres /backups/backup-20260920
docker rm -v yuanplan-backup-import
docker compose --env-file deploy/.env.restore -p yuanplan-restored run --rm ops node apps/server/dist/cli.js restore --input /backups/backup-20260920
# 重新核验迁移、授予运行账号权限并启动应用，仍处于维护模式
docker compose --env-file deploy/.env.restore -p yuanplan-restored up -d app
docker compose --env-file deploy/.env.restore -p yuanplan-restored ps -a
# 检查恢复结果与配置后开放访问
docker compose --env-file deploy/.env.restore -p yuanplan-restored run --rm ops node apps/server/dist/cli.js maintenance --state off
```

仅恢复可信来源的备份：SHA-256 用于检测损坏，不证明来源可信，数据库归档可包含可执行 SQL。恢复预先核验密钥指纹、数据库归档及全部附件，再检查目标数据库和附件目录为空，使用单事务导入数据库。成功后核对迁移、附件清单和维护状态。中途失败可能留下附件及 `RESTORE_INCOMPLETE` 标记；保留现场排障，重新准备空目标，不覆盖现有实例。数据库权限不随归档导入，由迁移程序统一重建。

普通主机也可用 `npm run ops -- maintenance --state on`、`backup --output <目录>`、`restore --input <目录>`。设置 `MAINTENANCE_DATABASE_URL` 或 `MIGRATION_DATABASE_URL` 作为运维连接，恢复显式设置 `RESTORE_DATABASE_URL` 和目标 `UPLOAD_DIR`。PATH 需要可连接目标版本的 `pg_dump`/`pg_restore`，也可用 `PG_DUMP_BIN`/`PG_RESTORE_BIN` 指定程序路径。

## 升级与失败处理

当前容器基础发行版为 Alpine 3.24。若从其他操作系统或基础发行版迁移，先在全新卷中进行逻辑备份恢复演练，并检查 locale / collation 与索引；不要直接复用旧数据库文件目录来切换发行版。


1. 在独立恢复环境先验证目标版本及迁移，记录当前提交/镜像标识。
2. 开启维护并完成、导出、验证备份；停止旧应用，避免旧进程继续写入。
3. 获取目标版本，构建镜像，执行 `docker compose --env-file deploy/.env run --rm migrate`。
4. 迁移成功后启动应用，核验健康、业务数据、附件和权限，再关闭维护。

迁移失败会以非零状态退出，应用依赖检查不会放行。保留日志和备份，排查后修复迁移；不要改写已经执行的迁移文件，也不要仅换旧镜像来掩盖 schema 不兼容。需要回退时，使用升级前的代码/镜像和一致备份恢复到空环境，验证后切换访问。原实例保留供排障。

公开仓库提供通用部署与恢复步骤，不包含任何实际实例的连接信息或内部恢复记录。上线前请在自己的隔离环境验证完整恢复切换。实现依据：[PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)、[pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)、[Compose 启动依赖](https://docs.docker.com/compose/how-tos/startup-order/)。
