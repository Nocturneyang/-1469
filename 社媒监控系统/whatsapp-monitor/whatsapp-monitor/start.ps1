# WhatsApp Monitor - Windows 启动脚本
# PowerShell 原生，无需安装 pm2

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

Write-Host ""
Write-Host "  =========================================="
Write-Host "    WhatsApp Monitor v2.0"
Write-Host "    群聊智能监控 + 可视化控制台"
Write-Host "  =========================================="
Write-Host ""

# 检查 Node.js，若未安装则自动通过 winget 安装
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [INFO] 未检测到 Node.js，尝试自动安装..."

    $hasWinget = Get-Command winget -ErrorAction SilentlyContinue
    if ($hasWinget) {
        Write-Host "  [INFO] 正在通过 winget 安装 Node.js LTS，请稍候（约 1-3 分钟）..."
        winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [错误] 自动安装失败，请手动下载安装：https://nodejs.org"
            Start-Process "https://nodejs.org/en/download"
            Read-Host "  按 Enter 退出"
            exit 1
        }
        # 刷新当前会话的 PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            Write-Host "  [OK] Node.js 安装完成！请重新运行 start.ps1 继续。"
            Read-Host "  按 Enter 退出"
            exit 0
        }
        Write-Host "  [OK] Node.js 安装成功！"
    } else {
        Write-Host "  [错误] winget 不可用，请手动安装 Node.js LTS："
        Write-Host "         https://nodejs.org/en/download"
        Start-Process "https://nodejs.org/en/download"
        Read-Host "  按 Enter 退出"
        exit 1
    }
}
$nodeVer = node -v
Write-Host "  [OK] Node.js $nodeVer"


Set-Location $Root

# 安装依赖（首次）
if (-not (Test-Path "$Root\node_modules\express")) {
    Write-Host ""
    Write-Host "  [INFO] 首次运行，正在安装依赖（约 200MB，请耐心等待）..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [错误] 依赖安装失败，请检查网络"
        Read-Host "按 Enter 退出"
        exit 1
    }
    Write-Host "  [OK] 依赖安装完成"
}

# 自动生成 .env（如果不存在）
if (-not (Test-Path "$Root\.env")) {
    Write-Host ""
    Write-Host "  [INFO] 未找到 .env 文件，正在从 .env.example 自动生成..."
    Copy-Item "$Root\.env.example" "$Root\.env" -Force
    Write-Host "  [警告] 初始化完成！您可以后续在 .env 文件中填入 API Key 及修改配置。"
    Write-Host ""
}

# 停止旧进程（如有）
$pidFile = "$Root\monitor.pid"
if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($oldPid) {
        try { Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue } catch {}
        Write-Host "  [INFO] 已停止旧进程 (PID $oldPid)"
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "  [INFO] 启动后台服务..."

# 用 Start-Process 在后台启动 Node（关闭当前窗口后继续运行）
$proc = Start-Process `
    -FilePath "node" `
    -ArgumentList "index.js" `
    -WorkingDirectory $Root `
    -RedirectStandardOutput "$Root\monitor.log" `
    -RedirectStandardError  "$Root\monitor_error.log" `
    -WindowStyle Hidden `
    -PassThru

# 保存 PID 供 stop.ps1 使用
$proc.Id | Out-File -FilePath $pidFile -Encoding ascii
Write-Host "  [OK] 进程已启动 (PID $($proc.Id))"

# 轮询等待服务就绪
Write-Host "  [INFO] 等待服务就绪..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 1
        $ready = $true
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}

if ($ready) {
    Write-Host "  [OK] 服务就绪！正在打开浏览器..."
    Start-Process "http://localhost:3000"
} else {
    Write-Host "  [警告] 等待超时，请手动打开浏览器访问 http://localhost:3000"
}

Write-Host ""
Write-Host "  =========================================="
Write-Host "    已在后台运行，关闭此窗口不影响运行"
Write-Host "    控制台: http://localhost:3000"
Write-Host "    日志:   monitor.log / monitor_error.log"
Write-Host "    停止:   运行 stop.bat"
Write-Host "  =========================================="
Write-Host ""

Read-Host "  按 Enter 关闭此窗口（程序继续在后台运行）"
