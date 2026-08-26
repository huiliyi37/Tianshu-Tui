<#
=============================================================================
  天枢一键安装器 (Tianshu One-Click Installer)
------------------------------------------------------------------------------
  流程:
    1. 检查 WebView2 Runtime 是否存在 / 是否够新 (注册表 pv 值)
    2. 缺失或过旧 -> 用官方引导器静默安装 / 更新到最新常青版
    3. 运行天枢安装包 setup.exe (WiX Burn) 安装天枢
  用户只需双击入口脚本, 运行一次完成全部。

  用法:
    install-tianshu.ps1 [-DryRun] [-ForceUpdate] [-MinVersion <ver>]
                        [-SetupExe <path>] [-WebView2Bootstrap <path>]
  - DryRun           : 只检查并报告将执行的动作, 不安装任何东西 (验证用)
  - ForceUpdate      : 即使 WebView2 已安装且版本足够, 也强制运行引导器更新
  - MinVersion       : WebView2 最低可接受版本 (默认 151.0.0.0)
  - SetupExe         : 天枢安装包路径 (默认: 脚本同目录 -> 用户 Downloads 自动查找)
  - WebView2Bootstrap: WebView2 引导器路径 (默认: 脚本同目录 -> 桌面"天枢修复工具"
                       -> 自动从微软官方下载)
=============================================================================
#>
param(
    [switch]$DryRun,
    [switch]$ForceUpdate,
    [string]$MinVersion = "151.0.0.0",
    [string]$SetupExe = "",
    [string]$WebView2Bootstrap = ""
)

$ErrorActionPreference = "Stop"
$script:WEBVIEW2_GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$script:WEBVIEW2_REG   = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$script:WEBVIEW2_GUID"
$script:WEBVIEW2_DIR   = "C:\Program Files (x86)\Microsoft\EdgeWebView\Application"
$script:BOOTSTRAP_URL  = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
$script:ScriptDir      = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step($msg) { Write-Host ""; Write-Host ("=== " + $msg + " ===") -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host ("  [OK] " + $msg) -ForegroundColor Green }
function Write-Warn($msg) { Write-Host ("  [..] " + $msg) -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host ("  [!!] " + $msg) -ForegroundColor Red }

# 版本字符串 -> 数字段数组 (非数字段按 0 处理, 防止脏数据崩溃)
function ConvertTo-VersionParts([string]$ver) {
    $parts = @()
    foreach ($seg in $ver.Split('.')) {
        $n = 0
        [void][int]::TryParse($seg, [ref]$n)
        $parts += $n
    }
    return $parts
}

# 四段版本号比较: $a 是否 >= $b
function Test-VersionAtLeast([string]$a, [string]$b) {
    $pa = ConvertTo-VersionParts $a
    $pb = ConvertTo-VersionParts $b
    for ($i = 0; $i -lt 4; $i++) {
        $va = if ($i -lt $pa.Count) { $pa[$i] } else { 0 }
        $vb = if ($i -lt $pb.Count) { $pb[$i] } else { 0 }
        if ($va -gt $vb) { return $true }
        if ($va -lt $vb) { return $false }
    }
    return $true
}

# 读取已安装的 WebView2 版本 (注册表优先, 文件系统兜底)
function Get-InstalledWebView2Version {
    try {
        $v = (Get-ItemProperty $script:WEBVIEW2_REG -Name pv -ErrorAction Stop).pv
        if ($v) { return ([string]$v).Trim() }
    } catch { }
    if (Test-Path $script:WEBVIEW2_DIR) {
        $vers = Get-ChildItem $script:WEBVIEW2_DIR -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
                ForEach-Object { $_.Name }
        if ($vers.Count -gt 0) {
            $sorted = $vers | Sort-Object -Property { [version]$_ } -Descending
            return $sorted[0]
        }
    }
    return $null
}

# 定位天枢安装包
function Resolve-SetupExe {
    if ($SetupExe) {
        if (Test-Path $SetupExe) { return $SetupExe }
        throw "指定的安装包不存在: $SetupExe"
    }
    $candidates = @()
    $candidates += Join-Path $script:ScriptDir "Tianshu_*setup.exe"
    $candidates += Join-Path $env:USERPROFILE "Downloads\Tianshu_*setup.exe"
    foreach ($pat in $candidates) {
        $hit = Get-ChildItem -Path (Split-Path $pat) -Filter (Split-Path $pat -Leaf) -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

# 定位 WebView2 引导器; 找不到时下载官方引导器
function Resolve-Bootstrap {
    if ($WebView2Bootstrap) {
        if (Test-Path $WebView2Bootstrap) { return $WebView2Bootstrap }
        throw "指定的引导器不存在: $WebView2Bootstrap"
    }
    $local = Join-Path $script:ScriptDir "MicrosoftEdgeWebView2Setup.exe"
    if (Test-Path $local) { return $local }
    $fixTool = Join-Path $env:USERPROFILE "Desktop\天枢修复工具\MicrosoftEdgeWebView2Setup.exe"
    if (Test-Path $fixTool) { return $fixTool }
    return $null
}

# 下载官方 WebView2 引导器
function Download-Bootstrap {
    $target = Join-Path $script:ScriptDir "MicrosoftEdgeWebView2Setup.exe"
    Write-Info "正在从微软官方下载 WebView2 引导器..."
    if ($DryRun) { return $target }
    try {
        Invoke-WebRequest -Uri $script:BOOTSTRAP_URL -OutFile $target -UseBasicParsing
        if (-not (Test-Path $target)) { throw "下载后文件不存在" }
        return $target
    } catch {
        throw "WebView2 引导器下载失败: $($_.Exception.Message)"
    }
}

function Write-Info($msg) { Write-Host ("  " + $msg) }

# 统一退出: 非 DryRun 时暂停等待回车, 避免提权窗口一闪而过丢失错误信息
# (非交互环境 Read-Host 抛异常时静默跳过暂停)
function Exit-Installer([int]$code) {
    if (-not $DryRun) {
        try { Read-Host "`n按回车键退出" } catch { }
    }
    exit $code
}

# ---------- 管理员自检: 非管理员时自动请求 UAC 提权 (DryRun 只读无需提权) ----------
$isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun) {
    Write-Warn "当前不是管理员权限, 正在请求提权 (UAC 弹窗请点「是」)..."
    try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', "`"$PSCommandPath`"") -Verb RunAs
    } catch {
        Write-Err "提权被取消或失败: $($_.Exception.Message)"
        Exit-Installer 1
    }
    exit 0
}

# ---------- 步骤 1: 检查 WebView2 ----------
Write-Step "步骤 1/3: 检查 WebView2 Runtime"
$installed = Get-InstalledWebView2Version
$needWebView2 = $false

if ($installed) {
    Write-Ok "已安装 WebView2 Runtime, 版本: $installed"
    if ($ForceUpdate) {
        Write-Warn "检测到 -ForceUpdate, 将强制运行引导器更新到最新常青版"
        $needWebView2 = $true
    } elseif (-not (Test-VersionAtLeast $installed $MinVersion)) {
        Write-Warn "当前版本 ($installed) 低于要求 ($MinVersion), 将更新"
        $needWebView2 = $true
    } else {
        Write-Ok "版本满足要求, 跳过 WebView2 安装"
    }
} else {
    Write-Warn "未检测到 WebView2 Runtime, 需要安装"
    $needWebView2 = $true
}

# ---------- 步骤 2: 安装/更新 WebView2 ----------
if ($needWebView2) {
    Write-Step "步骤 2/3: 安装 / 更新 WebView2 Runtime"
    $bootstrap = Resolve-Bootstrap
    if (-not $bootstrap) {
        Write-Warn "本地未找到引导器, 将自动下载"
        $bootstrap = Download-Bootstrap
    } else {
        Write-Ok "使用引导器: $bootstrap"
    }
    Write-Info "执行: `"$bootstrap`" /silent /install"
    if (-not $DryRun) {
        $p = Start-Process -FilePath $bootstrap -ArgumentList "/silent","/install" -Wait -PassThru
        $code = $p.ExitCode
        if ($code -eq 0 -or $code -eq 3010) {
            Write-Ok "WebView2 安装/更新完成 (返回码 $code)"
        } else {
            Write-Err "WebView2 安装失败 (返回码 $code)"
            Write-Err "可手动访问 https://developer.microsoft.com/microsoft-edge/webview2/ 安装后重试"
            Exit-Installer 1
        }
        $after = Get-InstalledWebView2Version
        if (-not $after) {
            Write-Err "安装后仍检测不到 WebView2, 请手动安装"
            Exit-Installer 1
        }
        if (-not (Test-VersionAtLeast $after $MinVersion)) {
            Write-Err "安装后版本 ($after) 仍低于要求 ($MinVersion), 请手动安装最新版 WebView2"
            Exit-Installer 1
        }
        Write-Ok "安装后版本: $after (满足 >= $MinVersion 要求)"
    } else {
        Write-Warn "[DryRun] 将执行上述安装命令 (未实际执行)"
    }
} else {
    Write-Step "步骤 2/3: WebView2 已就绪, 跳过"
}

# ---------- 步骤 3: 安装天枢 ----------
Write-Step "步骤 3/3: 安装天枢"
try {
    $setup = Resolve-SetupExe
} catch {
    Write-Err $_.Exception.Message
    Exit-Installer 2
}
if (-not $setup) {
    Write-Err "未找到天枢安装包 (Tianshu_*_setup.exe)"
    Write-Err "请将安装包放到本脚本同目录, 或用 -SetupExe 指定路径"
    Exit-Installer 2
}
Write-Ok "使用安装包: $setup"
Write-Info "执行: `"$setup`" (请在弹出的安装向导中完成安装)"
if (-not $DryRun) {
    $p = Start-Process -FilePath $setup -Wait -PassThru
    $code = $p.ExitCode
    # WiX Burn 返回码: 0 = 成功; 3010 = 成功但需重启; 其他为错误
    if ($code -eq 0) {
        Write-Ok "天枢安装完成"
    } elseif ($code -eq 3010) {
        Write-Warn "天枢安装完成, 但系统需要重启后才能生效"
    } else {
        Write-Err "天枢安装返回异常代码: $code (0x$('{0:X8}' -f $code))"
        Exit-Installer 3
    }
} else {
    Write-Warn "[DryRun] 将启动上述安装包 (未实际执行)"
}

Write-Step "全部完成"
if ($DryRun) {
    Write-Ok "DryRun 模式: 未做任何实际安装。确认无误后, 双击「安装天枢.cmd」正式安装。"
}
Exit-Installer 0
