# Tianshu Desktop — Windows 签名打包脚本
# 用法: powershell -ExecutionPolicy Bypass -File desktop/scripts/build-signed.ps1
#
# 原理: tauri build 的内置签名在 Windows 上读不到空密码 env var,
#       所以分两步: 先 build 出裸包(createUpdaterArtifacts=false),
#       再用 tauri signer sign 手动签(这步 env 正常)。

param(
    [string]$KeyPath = (Join-Path $env:USERPROFILE ".tauri" "tianshu.key"),
    [string]$KeyPassword = "",
    [string]$RepoSlug = "huiliyi37/Tianshu-Tui"
)

$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\.."

$confPath = "src-tauri\tauri.conf.json"
$backupPath = "$confPath.bak"

function Set-UpdaterArtifacts {
    param([bool]$enabled)
    $raw = Get-Content $confPath -Raw
    $value = if ($enabled) { "true" } else { "false" }
    # 兼容任意空白与 true/false 大小写
    $raw = $raw -replace '("createUpdaterArtifacts"\s*:\s*)(true|false)', "`$1$value"
    $raw | Set-Content $confPath -NoNewline
}

function Assert-Command {
    param([string]$name)
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "$name 命令未找到，请先安装依赖 (pnpm/npm install)"
    }
}

function Assert-Path {
    param([string]$path, [string]$desc)
    if (-not (Test-Path $path)) { throw "$desc 不存在: $path" }
}

Assert-Command npx
Assert-Path $KeyPath "签名私钥"

# 备份配置
Copy-Item $confPath $backupPath -Force

# Step 1: build 不签名
Write-Host "[1/4] Building (no signing)..."
Set-UpdaterArtifacts -enabled $false
try {
    npx tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed: exit $LASTEXITCODE" }
}
finally {
    # 恢复 createUpdaterArtifacts: true
    Set-UpdaterArtifacts -enabled $true
    Remove-Item $backupPath -Force -ErrorAction SilentlyContinue
}

# Step 2: 手动签名
Write-Host "[2/4] Signing..."
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $KeyPath -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $KeyPassword

$nsisExe = Get-ChildItem "src-tauri\target\release\bundle\nsis\*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$msiFile = Get-ChildItem "src-tauri\target\release\bundle\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $nsisExe) { throw "NSIS installer not found in src-tauri\target\release\bundle\nsis\" }
if (-not $msiFile) { throw "MSI installer not found in src-tauri\target\release\bundle\msi\" }

npx tauri signer sign $nsisExe.FullName
if ($LASTEXITCODE -ne 0) { throw "sign NSIS failed" }
npx tauri signer sign $msiFile.FullName
if ($LASTEXITCODE -ne 0) { throw "sign MSI failed" }

# Step 3: 生成 latest.json
Write-Host "[3/4] Generating latest.json..."
$version = (Get-Content $confPath -Raw | ConvertFrom-Json).version
$notes = "$version release"
$downloadBase = "https://github.com/$RepoSlug/releases/download/v$version"
$bundleDir = "src-tauri\target\release\bundle"

node scripts\gen-latest-json.js --version $version --notes $notes --bundle-dir $bundleDir --download-base $downloadBase > "$bundleDir\latest.json"
if ($LASTEXITCODE -ne 0) { throw "gen-latest-json failed" }

# Step 4: 验证
Write-Host "[4/4] Verifying..."
$sig = "$($nsisExe.FullName).sig"
$latest = "$bundleDir\latest.json"
$ok = $true
foreach ($f in @($nsisExe.FullName, $sig, $latest)) {
    if (-not (Test-Path $f)) { Write-Host "  MISSING: $f"; $ok = $false }
    else { Write-Host "  OK: $f ($([math]::Round((Get-Item $f).Length/1MB,2)) MB)" }
}
if ($ok) { Write-Host "`nDone! Upload these 3 files to GitHub Release v$version." }
else { Write-Host "`nFAILED: some artifacts missing." ; exit 1 }
