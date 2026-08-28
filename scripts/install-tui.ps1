# 天枢（Tianshu）CLI 一键安装 + 启动（Windows PowerShell 5.1+ / PowerShell 7）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1             # 安装 + 启动
#   powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1 -NoLaunch  # 只安装
#
# 远程一键（irm | iex；参数开关仅克隆仓库本地跑时可带）：
#   powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/huiliyi37/Tianshu-Tui/main/scripts/install-tui.ps1 | iex"
#
# 说明：
#   - 官方 npm 包 tianshu-tui，命令名 rivet；需要 Node.js >= 24（engines 钉死）。
#   - 默认走 npmmirror 镜像（国内网络加速）；设 NPM_CONFIG_REGISTRY 可覆盖。
#   - 幂等：重复执行覆盖升级到最新版。
param([switch]$NoLaunch)

$ErrorActionPreference = "Stop"
$Registry = if ($env:NPM_CONFIG_REGISTRY) { $env:NPM_CONFIG_REGISTRY } else { "https://registry.npmmirror.com" }
# npm 经环境变量读 registry（大小写两份都设，与 install-tui.sh 同口径）
$env:NPM_CONFIG_REGISTRY = $Registry
$env:npm_config_registry = $Registry

function Say([string]$Text) { Write-Host "== $Text ==" -ForegroundColor Cyan }
function Die([string]$Text) { Write-Host "x $Text" -ForegroundColor Red; exit 1 }

# 1. Node.js >= 24
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "缺少 Node.js（>= 24）。请先安装：https://nodejs.org/"
}
$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]"))
if ($NodeMajor -lt 24) {
  Die "Node.js 版本过低（$(node -v)，需要 >= 24）。请升级后重跑。"
}

# 2. 全局安装（幂等：重复执行覆盖升级）
Say "安装天枢 CLI tianshu-tui（registry=$Registry）"
npm install -g tianshu-tui
if ($LASTEXITCODE -ne 0) {
  Die "安装失败（exit $LASTEXITCODE）。可换官方源：`$env:NPM_CONFIG_REGISTRY='https://registry.npmjs.org' 后重跑"
}

# 3. 验证 + 启动（装 Node 时开着的旧终端拿不到新 PATH——新开终端即可，沿用 README 口径）
if ($NoLaunch) {
  Write-Host ""
  Write-Host "安装完成。下一步（新开一个终端）："
  Write-Host "  rivet                # 启动（任意目录，进入会话）"
  Write-Host "  rivet --version      # 查看版本"
  Write-Host ""
  Write-Host "首次使用：启动后输入 /connect 走供应商连接向导配置 API Key，或 setx DEEPSEEK_API_KEY sk-*** 后新开终端。"
  Write-Host "桌面端安装包（macOS 双架构 / Windows）：https://github.com/huiliyi37/Tianshu-Tui/releases"
  exit 0
}
Say "启动天枢 rivet"
rivet
