#!/bin/bash
# 取得当前脚本所在的目录并进入
cd "$(dirname "$0")"

echo "=========================================="
echo "    多平台社媒监控系统 - 启动器"
echo "=========================================="

# 检查是否安装 npm/node
if ! command -v npm &> /dev/null; then
    echo "错误：未找到 Node.js (npm). 请先在您的 Mac 上安装 Node.js！"
    exit 1
fi

# 检查依赖包
if [ ! -d "node_modules" ]; then
    echo "初次运行，正在为您安装相关依赖..."
    npm install
fi

# 确保安装了 puppeteer browser
npx puppeteer browsers install chrome

# 检查并安装 PM2 (如果本地可用 npx 则不需要全局，但稳妥起见提供 npx 执行)
echo "正在为您启动采集守护进程..."
npx pm2 start ecosystem.config.js --env production

echo ""
echo "=========================================="
echo "✅ 进程启动成功！系统已经在后台常驻守护。"
echo ""
echo "📱 接下来将为您调出 WhatsApp 二维码登录页。"
echo "请准备好您的手机进行扫码..."
echo "（如果您已经登录，此页面将显示后台运行状况）"
echo "💡 提示：按键盘上的【Ctrl + C】可以退出日志查看，监控依然会在后台继续！"
echo "=========================================="
sleep 3

# 直接查看 WhatsApp 进程的日志用于展示二维码
npx pm2 logs worker-wa-1
