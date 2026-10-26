# 一键停用 MAA 插件（DSH 起不来时的自救脚本）
#
# 用法（在普通 PowerShell 窗口里跑，不需要 DSH）：
#   powershell -ExecutionPolicy Bypass -File "plugins\maa-plugin\scripts\recover.ps1"
#
# 做什么：
#   1. 备份 profile 的 package.json
#   2. 从 dsh.profile.bundles 里移除 @local/dsh-maa（bundle 不选中 = 它的插件行与客户端模块都不再加载）
#   3. 打印下一步
# 不做：删除插件目录、改你的其它配置。

$ErrorActionPreference = 'Stop'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$pkgFile = Join-Path $profileDir 'package.json'
$target = '@local/dsh-maa'

if (-not (Test-Path $pkgFile)) {
  Write-Host "找不到 profile：$pkgFile" -ForegroundColor Red
  exit 1
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $pkgFile "$pkgFile.bak-$stamp"
Write-Host "已备份：$pkgFile.bak-$stamp"

$json = Get-Content $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
$before = @($json.dsh.profile.bundles)
$after = @($before | Where-Object { $_ -ne $target })

if ($before.Count -eq $after.Count) {
  Write-Host "bundles 里本来就没有 $target，无需改动。" -ForegroundColor Yellow
} else {
  $json.dsh.profile.bundles = $after
  # ConvertTo-Json 默认深度不够，这里显式给足
  $json | ConvertTo-Json -Depth 10 | Set-Content $pkgFile -Encoding UTF8
  Write-Host "已从 dsh.profile.bundles 移除 $target" -ForegroundColor Green
  Write-Host "现在：$($after -join ', ')"
}

Write-Host ""
Write-Host "下一步：重启 DSH。若仍起不来，把 $pkgFile 换成上面的备份文件再试。" -ForegroundColor Cyan
