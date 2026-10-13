<#
  YuanPlan 局域网一键部署脚本（明文 HTTP 版）
  ------------------------------------------------------------------
  用途：在“充当服务器”的那台 Windows 机器上执行本脚本，
        自动完成：检测本机 IP → 生成配置与密钥 → 导入镜像 → 启动服务
        → 放行防火墙。

  前提：已安装并启动 Docker Desktop。

  用法（在本文件夹根目录执行；必须带 -ExecutionPolicy Bypass，
  否则系统默认策略会拒绝运行脚本）：
      powershell -ExecutionPolicy Bypass -File deploy\lan-setup.ps1

  常用参数：
      -LanHost 10.0.0.50     手动指定本机局域网 IP（默认自动检测）
      -HttpPort 8080         局域网访问端口（默认沿用 deploy\.env，首次为 18420）
      -SkipFirewall          跳过防火墙放行（需管理员权限才能放行）
      -RegenerateSecrets     重新生成全部密钥（会让已存在的账号会话失效）

  关于安全性：本方案走明文 HTTP，适合可信内网，不需要装任何证书。
  代价是登录密码在网络上不加密，且浏览器会降级少量 API（例如“复制”按钮
  需要手动选择文本）。说明见 部署说明.md。

  换 IP 或换端口后怎么办：直接重新运行一次本脚本即可——它会保留原有密钥，
  只更新地址相关配置，然后重建容器。
#>
[CmdletBinding()]
param(
    [string]$LanHost = "",
    [int]$HttpPort = 0,
    [switch]$SkipFirewall,
    [switch]$RegenerateSecrets
)

# 注意：这里刻意使用 Continue 而不是 Stop。
# docker 会把正常的进度信息写到 stderr，若配合 Stop，PowerShell 会把它
# 当成 NativeCommandError 并中断脚本。因此本脚本对所有外部命令都显式
# 检查 $LASTEXITCODE，不依赖异常机制。
$ErrorActionPreference = "Continue"

# ---------- 输出辅助 ----------
function Info($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[X] $m" -ForegroundColor Red; exit 1 }

# 脚本位于 <bundle>\deploy\ ，bundle 根目录就是上一级
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path $root)) { Die "无法定位工作目录：$root" }
Set-Location $root

Write-Host ""
Write-Host "=== YuanPlan 局域网部署（明文 HTTP）===" -ForegroundColor White
Info "工作目录: $root"
Write-Host ""

# ---------- 1. 检查 Docker ----------
Info "检查 Docker ..."
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Die "未找到 docker 命令。请先安装 Docker Desktop：https://www.docker.com/products/docker-desktop/"
}

$dv = (docker info --format "{{.ServerVersion}}" 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $dv) {
    Die "Docker 已安装但引擎未运行。请先启动 Docker Desktop，等托盘图标变成绿色后再试。"
}
Ok "Docker 引擎运行中 (Server $dv)"

$cv = (docker compose version --short 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { Die "当前 Docker 不支持 compose 子命令，请升级 Docker Desktop。" }
Ok "compose 可用 ($cv)"

# ---------- 2. 确定局域网 IP ----------
function Get-LanIPv4 {
    # 优先：有默认网关、网卡已连接、非 169.254 自动私有地址
    $c = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
         Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address -ne $null } |
         ForEach-Object { $_.IPv4Address.IPAddress } |
         Where-Object { $_ -notlike '169.254.*' -and $_ -ne '127.0.0.1' }
    if ($c) { return @($c)[0] }

    # 退化：任意非回环 IPv4（例如多网卡、无网关的隔离网段）
    $c2 = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
          Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
          ForEach-Object { $_.IPAddress }
    if ($c2) { return @($c2)[0] }
    return ""
}

if (-not $LanHost) {
    Info "自动检测局域网 IP ..."
    $LanHost = Get-LanIPv4
    if (-not $LanHost) { Die "无法自动检测到局域网 IP，请用 -LanHost <你的IP> 手动指定。" }
}
if ($LanHost -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
    Die "IP 格式不合法：$LanHost"
}
Ok "局域网地址: $LanHost"

# ---------- 3. 读取已有配置 ----------
$envPath = Join-Path $root 'deploy\.env'

# 读取 .env 并解析成哈希表。
#
# 为什么要试两种编码：本文件是 UTF-8（无 BOM），但 PowerShell 5.1 的 Get-Content
# 默认按系统 ANSI 码页（简体中文为 GBK）解码。中文注释被错误解码后字节配对会错位，
# 反过来“吞掉”紧随其后的 ASCII 行 —— 实测中 HTTP_PORT 等行会整行消失，
# 导致重跑脚本时静默丢失配置。反过来，若用户用记事本把文件另存为 ANSI，
# 则又需要按 GBK 读。所以两种都试，取解析出条目更多的那个。
function Read-EnvFile([string]$path) {
    $re = '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$'
    $encodings = @([System.Text.Encoding]::UTF8)
    try { $encodings += [System.Text.Encoding]::GetEncoding(936) } catch { }
    $best = @{}
    foreach ($enc in $encodings) {
        $map = @{}
        try {
            foreach ($ln in [System.IO.File]::ReadAllLines($path, $enc)) {
                if ($ln -match $re) { $map[$matches[1]] = $matches[2] }
            }
        } catch { continue }
        if ($map.Count -gt $best.Count) { $best = $map }
    }
    return $best
}

# 读取已有配置，保留其中的密钥（换 IP 时不必换密钥）
$existing = @{}
if (Test-Path $envPath) { $existing = Read-EnvFile $envPath }

# ---------- 4. 确定端口 ----------
# 优先用命令行参数；否则沿用 deploy\.env 里已有的值；首次运行用 18420。
if ($HttpPort -le 0) {
    if ($existing.ContainsKey('HTTP_PORT') -and $existing['HTTP_PORT']) {
        $HttpPort = [int]$existing['HTTP_PORT']
    } else {
        $HttpPort = 18420
    }
}
if ($HttpPort -lt 1 -or $HttpPort -gt 65535) { Die "端口不合法：$HttpPort" }
$AppUrl = "http://${LanHost}:${HttpPort}"
Ok "访问端口: $HttpPort  →  $AppUrl"

# ---------- 5. 生成 / 保留密钥 ----------
function New-Hex([int]$n) {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $buf = New-Object byte[] $n
    $rng.GetBytes($buf)
    return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Pick-Secret([string]$key, [int]$bytes) {
    if ($RegenerateSecrets) { return (New-Hex $bytes) }
    if ($existing.ContainsKey($key) -and $existing[$key].Length -ge 16) { return $existing[$key] }
    return (New-Hex $bytes)
}

$authSecret  = Pick-Secret 'AUTH_SECRET' 32
$setupToken  = Pick-Secret 'SETUP_TOKEN' 18
$pgPassword  = Pick-Secret 'POSTGRES_PASSWORD' 24
$migPassword = Pick-Secret 'MIGRATION_DB_PASSWORD' 24
$appPassword = Pick-Secret 'APP_DB_PASSWORD' 24

$envContent = @"
# YuanPlan 局域网明文 HTTP 配置（由 deploy/lan-setup.ps1 自动生成）
# 服务地址: $AppUrl
#
# APP_URL 必须与同事浏览器里输入的地址完全一致（含端口）。
# 后端用它校验请求的 Host / Origin，不一致一律返回 403。
# 换 IP 或换端口后重新运行 lan-setup.ps1 会自动同步这一项。
APP_URL=$AppUrl

# 局域网访问端口。同事的访问地址就是 http://<本机IP>:<该端口>
HTTP_PORT=$HttpPort

# 绑定到所有网卡，否则只有本机能访问
BIND_ADDR=0.0.0.0

# 明文 HTTP 必须为 true：关闭会话 cookie 的 Secure 标志。
# 否则浏览器拒绝在 http:// 页面保存 cookie，表现为“能登录、一刷新就掉线”。
# 一旦改用 HTTPS 访问，必须改回 false。
INSECURE_HTTP=true

# 以下密钥在首次运行时生成，重新运行脚本会保留（除非加 -RegenerateSecrets）
AUTH_SECRET=$authSecret
SETUP_TOKEN=$setupToken
POSTGRES_PASSWORD=$pgPassword
MIGRATION_DB_PASSWORD=$migPassword
APP_DB_PASSWORD=$appPassword
"@

# UTF-8 无 BOM 写入（带 BOM 会让 docker compose 解析出脏字符）
try {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($envPath, $envContent, $enc)
} catch {
    Die "写入 deploy\.env 失败：$($_.Exception.Message)"
}

# 写完后立刻回读校验：编码一旦出问题，这里会马上暴露，
# 而不是等到容器起不来才发现。
$verify = Read-EnvFile $envPath
$required = @('APP_URL', 'HTTP_PORT', 'BIND_ADDR', 'INSECURE_HTTP', 'AUTH_SECRET', 'SETUP_TOKEN',
              'POSTGRES_PASSWORD', 'MIGRATION_DB_PASSWORD', 'APP_DB_PASSWORD')
foreach ($k in $required) {
    if (-not $verify.ContainsKey($k)) { Die "deploy\.env 写入校验失败：缺少 $k（疑似编码问题）" }
}
if ($verify['APP_URL'] -ne $AppUrl) {
    Die "deploy\.env 写入校验失败：APP_URL = '$($verify['APP_URL'])'，期望 '$AppUrl'"
}
if ($verify['HTTP_PORT'] -ne "$HttpPort") {
    Die "deploy\.env 写入校验失败：HTTP_PORT = '$($verify['HTTP_PORT'])'，期望 '$HttpPort'"
}
if ($verify['BIND_ADDR'] -ne '0.0.0.0') {
    Die "deploy\.env 写入校验失败：BIND_ADDR = '$($verify['BIND_ADDR'])'，期望 '0.0.0.0'"
}
if ($verify['INSECURE_HTTP'] -ne 'true') {
    Die "deploy\.env 写入校验失败：INSECURE_HTTP = '$($verify['INSECURE_HTTP'])'，期望 'true'"
}
Ok "已写入 deploy\.env 并通过回读校验"
if ($existing.ContainsKey('SETUP_TOKEN') -and $existing['SETUP_TOKEN'] -eq $setupToken) {
    Info "（沿用原有密钥）"
} else {
    Info "（本次生成/更换了密钥）"
}

# ---------- 6. 导入镜像 ----------
Info "检查镜像 ..."
$need = @('yuanplan:local', 'yuanplan-db:local')
# 用 docker images 判断，而不是 docker image inspect：
# 后者在镜像不存在时会往 stderr 写错误，容易干扰脚本流程。
function Get-LocalTags {
    return @(docker images --format "{{.Repository}}:{{.Tag}}" 2>$null | ForEach-Object { "$_".Trim() })
}
$localTags = Get-LocalTags
$missing = @()
foreach ($img in $need) {
    if ($localTags -notcontains $img) { $missing += $img }
}

if ($missing.Count -gt 0) {
    $tar = Get-ChildItem -Path (Join-Path $root 'images') -Filter '*.tar.gz' -ErrorAction SilentlyContinue |
           Select-Object -First 1
    if (-not $tar) {
        Die "缺少镜像 $($missing -join ', ')，且未找到 images\*.tar.gz。请把整个 images\ 目录一起拷贝过来。"
    }
    Warn "缺少镜像: $($missing -join ', ')"
    Info "正在导入 $($tar.Name) ...（约 2-5 分钟，请勿关闭窗口）"
    docker load -i $tar.FullName
    if ($LASTEXITCODE -ne 0) { Die "镜像导入失败，请确认 images\$($tar.Name) 完整。" }
    Ok "镜像导入完成"
    $localTags = Get-LocalTags
    foreach ($img in $need) {
        if ($localTags -notcontains $img) { Die "导入后仍缺少镜像 $img" }
    }
}
Ok "镜像就绪（$($need -join '、')）"

# ---------- 7. 清理旧版（HTTPS + Caddy）遗留物 ----------
$stale = @(docker ps -a --format "{{.Names}}" 2>$null | ForEach-Object { "$_".Trim() } |
           Where-Object { $_ -like 'yuanplan-caddy*' })
foreach ($c in $stale) {
    Info "移除旧版遗留容器 $c"
    docker rm -f $c | Out-Null
}
foreach ($v in @('yuanplan_caddy_data', 'yuanplan_caddy_config')) {
    $vol = (docker volume ls --format "{{.Name}}" 2>$null | ForEach-Object { "$_".Trim() } |
            Where-Object { $_ -eq $v })
    if ($vol) {
        Info "移除旧版遗留数据卷 $v（仅存放自签证书，可安全删除）"
        docker volume rm $v | Out-Null
    }
}

# ---------- 8. 启动服务 ----------
Info "启动服务 ...（首次启动需要初始化数据库，约 1-2 分钟）"
$composeArgs = @('compose', '--env-file', 'deploy/.env', '-f', 'compose.yaml')
# 交给 cmd /c 执行并显式合并 stderr：docker 会把正常进度写到 stderr，
# 若由 PowerShell 直接接收，在把输出重定向到日志文件时会被包装成
# NativeCommandError 大段红字，看起来像失败。经 cmd 处理后就是普通文本，
# 退出码仍然可通过 $LASTEXITCODE 拿到。
cmd /c ("docker " + ($composeArgs -join ' ') + " up -d --no-build 2>&1")
if ($LASTEXITCODE -ne 0) { Die "启动失败，请查看上面的错误信息。" }

# ---------- 9. 等待健康 ----------
Info "等待应用就绪 ..."
$healthy = $false
for ($i = 1; $i -le 60; $i++) {
    $st = (docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" yuanplan-app-1 2>$null | Out-String).Trim()
    if ($st -eq 'healthy') { $healthy = $true; break }
    Start-Sleep -Seconds 2
}
if ($healthy) { Ok "应用已就绪" } else { Warn "等待超时。可用 docker compose logs app 查看日志，服务可能仍在启动中。" }

# ---------- 10. 防火墙 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$ruleName = "YuanPlan LAN HTTP ($HttpPort)"

if ($SkipFirewall) {
    Warn "已跳过防火墙设置。同事若连不上，需手动放行 TCP $HttpPort 入站。"
} elseif (-not $isAdmin) {
    Warn "当前不是管理员，无法自动放行防火墙 —— 同事将完全连不上（连 ping 都不通）。"
    Warn "最快的补救：双击 deploy\allow-firewall.bat（会自动提权，几秒完成）。"
    Warn "或者手动执行下面这条命令（需管理员 PowerShell）："
    Write-Host ""
    Write-Host "  New-NetFirewallRule -DisplayName `"$ruleName`" -Direction Inbound -Protocol TCP -LocalPort $HttpPort -Action Allow -Profile Any" -ForegroundColor White
    Write-Host ""
} else {
    Info "放行防火墙 TCP $HttpPort ..."
    $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($rule) {
        Ok "防火墙规则已存在，跳过"
    } else {
        try {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $HttpPort -Action Allow -Profile Any | Out-Null
            Ok "已放行 TCP $HttpPort 入站"
        } catch {
            Warn "放行失败：$($_.Exception.Message)"
            Warn "请手动执行上面的 New-NetFirewallRule 命令。"
        }
    }
}

# 提示：旧版为 HTTPS 放过 443，升级后已无用，可自行清理
$oldRule = Get-NetFirewallRule -DisplayName 'YuanPlan LAN HTTPS (443)' -ErrorAction SilentlyContinue
if ($oldRule) {
    Warn "检测到旧版遗留的防火墙规则「YuanPlan LAN HTTPS (443)」，已不再需要。"
    Warn "可手动删除：Remove-NetFirewallRule -DisplayName 'YuanPlan LAN HTTPS (443)'"
}

# ---------- 11. 汇总 ----------
Write-Host ""
Write-Host "======================================================" -ForegroundColor White
Write-Host " 部署完成" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor White
Write-Host ""
Write-Host " 访问地址  : $AppUrl" -ForegroundColor White
Write-Host " 初始化令牌: $setupToken" -ForegroundColor Yellow
Write-Host ""
Write-Host " 把这个地址发给同事即可，他们不需要安装任何东西。" -ForegroundColor Gray
Write-Host " 第一次访问时用上面的初始化令牌创建管理员账号（仅需一次）。" -ForegroundColor Gray
Write-Host ""
Write-Host " 常用命令：" -ForegroundColor Gray
Write-Host "   状态  docker compose --env-file deploy/.env -f compose.yaml ps -a" -ForegroundColor Gray
Write-Host "   停止  docker compose --env-file deploy/.env -f compose.yaml stop" -ForegroundColor Gray
Write-Host "   启动  docker compose --env-file deploy/.env -f compose.yaml start" -ForegroundColor Gray
Write-Host "   日志  docker compose --env-file deploy/.env -f compose.yaml logs -f app" -ForegroundColor Gray
Write-Host ""
if (-not $isAdmin) {
    Write-Host " 提示：本次未以管理员运行，防火墙未放行 —— 同事可能连不上。" -ForegroundColor Yellow
    Write-Host "       请用管理员身份重跑一次本脚本，或双击 deploy\allow-firewall.bat。" -ForegroundColor Yellow
    Write-Host ""
}
