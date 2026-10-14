# YuanPlan 在 Linux 上部署（内网明文 HTTP）

> 面向：Linux 服务器 + 局域网访问。
> 为什么需要这份文档：`deploy/lan-setup.ps1` 和 `deploy/allow-firewall.bat` 都是 Windows 专用，
> Linux 上用不了。这里给出等价的手动步骤，条条可直接复制。

---

## 1. 前提

| 项目 | 要求 |
|---|---|
| 系统 | 任意主流 Linux（Ubuntu / Debian / CentOS / Rocky / Alma 均可） |
| Docker | Docker Engine 20.10+，且带 **compose 插件**（`docker compose`，非 `docker-compose`） |
| 架构 | x86_64 / amd64（镜像就是这个架构；ARM 需自行重建） |
| 内存 | ≥ 4 GB |
| 回环 | 服务器要在局域网上有一个固定 IP（建议路由器做 DHCP 保留或设静态 IP） |

检查是否就绪：

```bash
docker --version
docker compose version      # 必须能输出版本号，否则 compose 插件没装
docker info                 # 能输出内容说明 daemon 正常
```

如果 Docker 还没装（**服务器要能上外网**）：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"     # 把自己加进 docker 组
# 然后退出 SSH 重新登录一次，让组权限生效
```

> 内网完全隔离、上不了外网的情况：需要离线安装 Docker（下载 `docker-ce` 的 rpm/deb 包），
> 这一步没法用脚本代劳。

> 权限提示：如果 `docker info` 报 `permission denied`，要么重新登录让 `docker` 组生效，
> 要么在下面所有命令前加 `sudo`。**用了 `sudo` 就一路都用**，混用会导致镜像加载到不同用户下。

---

## 2. 把文件传到 Linux

从 Windows 上把这几样拷过去（用 WinSCP / `scp` / U盘 均可）：

```
YuanPlan-handoff/
├── compose.yaml                    ★ 必须
├── deploy/
│   ├── init-db.sh                  ★ 必须（db 容器挂载它做角色初始化）
│   └── .env.example                （可选，参考用）
└── images/
    └── yuanplan-images.tar.gz      ★ 必须（约 214 MB，含 2 个镜像）
```

建议放到 `/opt/yuanplan`：

```bash
sudo mkdir -p /opt/yuanplan && sudo chown "$USER" /opt/yuanplan
# 然后 scp 或 WinSCP 把文件传进 /opt/yuanplan
cd /opt/yuanplan
ls -la           # 确认 compose.yaml、deploy/、images/ 都在
```

> **不要**拷 `deploy/lan-setup.ps1` 和 `deploy/allow-firewall.bat` —— Linux 用不上。

> 用 scp 时保真：`scp -r` 或 WinSCP 的二进制模式。**别用文本模式**（会把换行符改成 CRLF，
> 导致 `init-db.sh` 在容器里执行失败）。

---

## 3. 生成 deploy/.env（一条命令搞定）

`deploy/.env` 里的密钥必须是**这台机器独立生成**的，别从 Windows 拷（那样两台机器密钥相同）。

```bash
cd /opt/yuanplan
mkdir -p deploy

# 1) 取本机局域网 IP：优先用默认路由的真实出口地址，取不到再退化为 hostname -I
LAN_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
[ -z "$LAN_IP" ] && LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "检测到的局域网 IP: $LAN_IP"        # ← 多网卡机器请核对这一行！

# 2) 密钥生成：有 openssl 就用它，没有就退回 /dev/urandom
gen() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# 3) 写入 .env（每个密钥现生成，两台机器不会相同）
cat > deploy/.env <<EOF
APP_URL=http://${LAN_IP}:18420
HTTP_PORT=18420
BIND_ADDR=0.0.0.0
INSECURE_HTTP=true
AUTH_SECRET=$(gen 32)
SETUP_TOKEN=$(gen 18)
POSTGRES_PASSWORD=$(gen 24)
MIGRATION_DB_PASSWORD=$(gen 24)
APP_DB_PASSWORD=$(gen 24)
EOF

cat deploy/.env     # 检查一眼：应该是 9 行，且密钥是一长串十六进制
```

**逐项说明**（每一条删了都会出问题）：

| 变量 | 作用 | 写错的后果 |
|---|---|---|
| `APP_URL` | 后端用它校验请求的 Host / Origin | 与浏览器地址不一致 → 一律 **403** |
| `HTTP_PORT` | 对外端口 | 防火墙也要同步放行这个端口 |
| `BIND_ADDR` | 监听地址，`0.0.0.0` = 所有网卡 | 写 `127.0.0.1` → **只有本机能访问** |
| `INSECURE_HTTP` | 关闭会话 cookie 的 Secure 标志 | 写 `false` → **能登录、一刷新就掉线** |
| `AUTH_SECRET` | 会话签名密钥，≥32 字符 | 太短启动直接报错 |
| `SETUP_TOKEN` | 首次创建管理员的令牌（≥24 字符） | 拿不到初始化入口 |
| 三个 DB 密码 | 数据库角色密码 | 为空则容器起不来 |

> **为什么取 IP 不以 `hostname -I` 打头？** 因为装了 Docker 的机器上，`hostname -I` 会把
> `docker0` 网桥的地址（172.17.0.1）也列出来，而且顺序不确定 —— 很容易取到错的那个。
> `ip route get 1.1.1.1` 取的是默认路由的真实出口地址，准得多。
> **但多网卡机器仍要人工核对**上面打印出来的那行 IP。取错了就手动改：
> `sed -i 's|^APP_URL=.*|APP_URL=http://192.168.1.50:18420|' deploy/.env`

> **`openssl` 可能不存在**（实测最小化的 Ubuntu 镜像里就没有）。上面的 `gen` 函数会自动降级到
> `/dev/urandom` + `od`，两种方式产出的都是等长十六进制串，效果完全一样。

---

## 4. 导入镜像并启动

```bash
cd /opt/yuanplan

# 导入两个镜像（约 2-5 分钟；docker load 会自动解压 .tar.gz）
docker load -i images/yuanplan-images.tar.gz

# 确认镜像在（应看到 yuanplan:local 和 yuanplan-db:local）
docker images | grep yuanplan

# 启动（--no-build 必须有：这个包不含源码，不允许它尝试构建）
docker compose --env-file deploy/.env -f compose.yaml up -d --no-build

# 查看状态：db 是 Up，migrate 应为 Exited (0)，app 应为 Up (healthy)
docker compose --env-file deploy/.env -f compose.yaml ps -a
```

`migrate` 容器会在 app 启动前自动跑完数据库迁移，**不需要手动执行任何 SQL**。

`app` 变成 `Up (healthy)` 大约要 1-2 分钟（首次要初始化数据库）。

---

## 5. 放行防火墙

Linux 上防火墙通常是**开着的**，不放行的话同事连不上。

```bash
# 先看这台机器用的是哪个
sudo ufw status          # Ubuntu / Debian
sudo firewall-cmd --state    # CentOS / Rocky / Alma / Fedora
```

按结果二选一：

```bash
# ufw（Ubuntu / Debian）
sudo ufw allow 18420/tcp

# firewalld（RHEL 系）
sudo firewall-cmd --permanent --add-port=18420/tcp
sudo firewall-cmd --reload
```

两者都没装 / 都没启用 → 不用管，通常能直接访问。

> 如果你在**云服务器**上，除了系统防火墙，**云控制台的安全组**也要放行（这一步只能在网页上做）。

---

## 6. 验证

```bash
# 服务器本机
curl http://127.0.0.1:18420/api/health
# 期望：{"status":"ok"}

# 用局域网 IP（换成 deploy/.env 里的 APP_URL 那个地址）
curl http://192.168.1.50:18420/api/health
```

两步都通 → 把 `http://<服务器IP>:18420` 发给同事即可，**他们不需要装任何东西**。

第一次访问时用 `deploy/.env` 里的 `SETUP_TOKEN` 创建管理员账号（只做一次）。

---

## 7. 日常运维

```bash
cd /opt/yuanplan
alias yp='docker compose --env-file deploy/.env -f compose.yaml'

yp ps -a          # 状态
yp logs -f app    # 日志
yp restart        # 重启
yp stop           # 停止
yp start          # 启动
```

容器设了 `restart: unless-stopped`，**服务器重启后会自动拉起**。

### 换 IP 或换端口之后

改 `deploy/.env` 里的 `APP_URL` / `HTTP_PORT`，然后：

```bash
docker compose --env-file deploy/.env -f compose.yaml up -d --no-build
```

数据、账号、附件都在 Docker 数据卷里，**不会丢**。但换了地址和端口后，所有人需要**重新登录一次**
（会话 cookie 绑在域名/端口上）。

### 备份

```bash
yp run --rm ops node apps/server/dist/cli.js maintenance --state on
yp run --name yuanplan-backup-export ops node apps/server/dist/cli.js backup --output /backups/backup-$(date +%Y%m%d)
mkdir -p .data
docker cp yuanplan-backup-export:/backups/backup-$(date +%Y%m%d) .data/
docker rm -v yuanplan-backup-export
yp run --rm ops node apps/server/dist/cli.js maintenance --state off
```

备份目录含数据库、全部附件和校验清单，**请另存到别处**。
另外请单独保管 `deploy/.env` 里的 `AUTH_SECRET` —— 恢复时不一致会被拒绝。

---

## 8. 常见问题

| 现象 | 原因与处理 |
|---|---|
| 同事故障：连不上，`curl` 超时 | 防火墙没放行（最常见）。见第 5 节。用 `ss -lntp \| grep 18420` 确认在监听 |
| 能打开页面，但登录后一刷新变回未登录 | `deploy/.env` 的 `INSECURE_HTTP` 不是 `true` |
| 页面能开，一点操作就 403 | `APP_URL` 与浏览器地址不一致（IP 或端口对不上）。改完重启 app |
| 只有本机能访问，别人不行 | `BIND_ADDR` 写成了 `127.0.0.1`，应为 `0.0.0.0` |
| `docker compose up` 报 `Cannot connect to the Docker daemon` | daemon 没起：`sudo systemctl start docker` |
| 报 `permission denied ... docker.sock` | 当前用户不在 docker 组。重新登录，或全程加 `sudo` |
| `docker load` 报 `unexpected EOF` | 压缩包传输损坏（多半是传输方式问题）。重新拷一次，校验大小是否一致 |
| 脚本报 `$'\r': command not found` | 文件是 CRLF 行尾（Windows 文本模式传过来的）。`sed -i 's/\r$//' 文件名` |
| 端口被占用 | 改 `deploy/.env` 的 `HTTP_PORT`，同步放行新端口的防火墙 |
| 找不到「注册」入口 | **正常。** 全新实例默认「仅限邀请」，用户靠邀请链接加入。想让所有人自己注册：系统管理 → 注册设置 → 「开放注册（无需邮箱验证）」 |

---

## 9. 与 Windows 版的关系

两端可以同时存在，互不影响：

| | Windows 部署机 | Linux 部署机 |
|---|---|---|
| 启动脚本 | `lan-setup.ps1`（自动） | 本文档（手动几步） |
| 防火墙 | `allow-firewall.bat` / `New-NetFirewallRule` | `ufw` / `firewalld` |
| 密钥 | 脚本自动生成 | 第 3 节的命令生成 |
| 镜像来源 | 同一个 `images/yuanplan-images.tar.gz` | 同左 |

**唯一的硬约束**：两台机器不要共用同一个 `AUTH_SECRET` 和数据库密码 —— 各生成各的。
