# Tianshu Desktop — Windows 签名打包脚本
# 用法: powershell -ExecutionPolicy Bypass -File desktop/scripts/build-signed.ps1
#
# 原理: tauri build 的内置签名在 Windows 上读不到空密码 env var,
#       所以分两步: 先 build 出裸包(createUpdaterArtifacts=false),
#       再用 tauri signer sign 手动签(这步 env 正常)。

$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\.."

$confPath = "src-tauri\tauri.conf.json"
$conf = Get-Content $confPath -Raw

# Step 1: build 不签名
Write-Host "[1/4] Building (no signing)..."
$conf -replace '"createUpdaterArtifacts":\s*true', '"createUpdaterArtifacts": false' | Set-Content $confPath -NoNewline
try {
    npx tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed: exit $LASTEXITCODE" }
} finally {
    # 恢复 createUpdaterArtifacts: true
    (Get-Content $confPath -Raw) -replace '"createUpdaterArtifacts":\s*false', '"createUpdaterArtifacts": true' | Set-Content $confPath -NoNewline
}

# Step 2: 手动签名
Write-Host "[2/4] Signing..."
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content "$env:USERPROFILE\.tauri\tianshu.key" -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

$nsisExe = Get-ChildItem "src-tauri\target\release\bundle\nsis\*-setup.exe" | Select-Object -First 1
$msiFile = Get-ChildItem "src-tauri\target\release\bundle\msi\*.msi" | Select-Object -First 1

if (-not $nsisExe) { throw "NSIS installer not found in bundle\nsis\" }
if (-not $msiFile) { throw "MSI installer not found in bundle\msi\" }

npx tauri signer sign $nsisExe.FullName
if ($LASTEXITCODE -ne 0) { throw "sign NSIS failed" }
npx tauri signer sign $msiFile.FullName
if ($LASTEXITCODE -ne 0) { throw "sign MSI failed" }

# Step 3: 生成 latest.json
Write-Host "[3/4] Generating latest.json..."
$version = (Get-Content $confPath -Raw | ConvertFrom-Json).version
$notes = "$version release"
$downloadBase = "https://github.com/huiliyi37/Tianshu-Tui/releases/download/v$version"
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
