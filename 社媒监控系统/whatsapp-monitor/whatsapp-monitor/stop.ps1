# WhatsApp Monitor - 停止脚本

$Root = $PSScriptRoot
$pidFile = "$Root\monitor.pid"

Write-Host ""
Write-Host "  [INFO] 正在停止 WhatsApp Monitor..."

$stopped = $false

# 方式1：通过 PID 文件停止
if (Test-Path $pidFile) {
    $savedPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($savedPid) {
        try {
            Stop-Process -Id ([int]$savedPid) -Force -ErrorAction Stop
            Write-Host "  [OK] 已停止进程 (PID $savedPid)"
            $stopped = $true
        } catch {
            Write-Host "  [INFO] 进程已不存在 (PID $savedPid)"
            $stopped = $true
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# 方式2：通过端口查找并停止
if (-not $stopped) {
    try {
        $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
        if ($conn) {
            Stop-Process -Id $conn.OwningProcess -Force
            Write-Host "  [OK] 已停止占用端口 3000 的进程"
        } else {
            Write-Host "  [INFO] 未找到正在运行的监控进程"
        }
    } catch {
        Write-Host "  [INFO] 未找到占用 3000 端口的进程"
    }
}

Write-Host ""
Read-Host "  按 Enter 关闭此窗口"
