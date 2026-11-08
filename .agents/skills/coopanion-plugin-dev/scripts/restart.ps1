# 重启 Coopanion:强制清场 -> 确认归零 -> 独立进程拉起 -> 验证新 PID。
# 用法:powershell -NoProfile -ExecutionPolicy Bypass -File restart.ps1
# 退出码 0 = 成功;非 0 = 失败,错误信息已写出。
$ErrorActionPreference = 'Stop'
$name = 'Coopanion'
$exe  = Join-Path $env:LOCALAPPDATA 'Programs\Coopanion\Coopanion.exe'

if (-not (Test-Path $exe)) {
  Write-Error "找不到 Coopanion.exe: $exe"
  exit 1
}

# 记录旧进程的 (PID -> 启动时刻)。Windows 会复用 PID:验证"换血"必须同时比对启动时刻,
# 否则新进程撞上旧 PID 会被误判成"没重启"。
$oldMap = @{}
foreach ($p in Get-Process -Name $name -ErrorAction SilentlyContinue) {
  $oldMap[[int]$p.Id] = $p.StartTime
}

# 1) 清场。不用优雅关闭:实测 taskkill(无 /F)会留残余进程,而 Electron 的
#    单实例锁会让新实例启动失败——表现是"重启后 PID 没变"。必须全部强杀。
if ($oldMap.Count -gt 0) {
  Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}
for ($i = 0; $i -lt 5; $i++) {
  if (-not (Get-Process -Name $name -ErrorAction SilentlyContinue)) { break }
  Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}
$left = Get-Process -Name $name -ErrorAction SilentlyContinue
# 重型后备:Stop-Process 杀不掉时(如主进程复活子进程的竞态),按进程树强制终止。
for ($i = 0; $i -lt 3 -and $left; $i++) {
  foreach ($proc in $left) {
    taskkill /F /T /PID $proc.Id 2>$null | Out-Null
  }
  Start-Sleep -Seconds 3
  $left = Get-Process -Name $name -ErrorAction SilentlyContinue
}
if ($left) {
  Write-Output "FAIL: 仍有 $($left.Count) 个进程无法结束(PID: $($left.Id -join ', '))"
  exit 1
}

# 2) 拉起。Start-Process 生成独立进程,不随调用方(shell)退出而消亡。
Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)

# 3) 验证:有进程,且 PID 与重启前不同。
Start-Sleep -Seconds 6
$new = Get-Process -Name $name -ErrorAction SilentlyContinue
if (-not $new) {
  Write-Output 'FAIL: 重启后没有发现 Coopanion 进程'
  exit 1
}
$newIds = @()
$stale = @()
foreach ($p in $new) {
  $pidInt = [int]$p.Id
  $newIds += $pidInt
  if ($oldMap.ContainsKey($pidInt) -and $p.StartTime -le $oldMap[$pidInt].AddSeconds(1)) {
    $stale += $pidInt
  }
}
if ($stale.Count -gt 0) {
  Write-Output "FAIL: 检测到重启前的旧进程仍存活(PID: $($stale -join ', '))——进程没有真正换血"
  exit 1
}
Write-Output "OK: Coopanion 已重启, $($newIds.Count) 个新进程 (PID: $($newIds -join ', '))"
exit 0
