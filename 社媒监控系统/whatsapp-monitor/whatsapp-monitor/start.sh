#!/bin/bash
set -e

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║    WhatsApp Monitor  v2.0 启动器          ║"
echo "  ║    群聊智能监控 + 可视化控制台             ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# 切换到脚本目录
cd "$(dirname "$0")"

# 检查 Node.js，若未安装则自动安装
if ! command -v node &>/dev/null; then
    echo "  [INFO] 未检测到 Node.js，尝试自动安装..."

    # 优先使用 nvm（跨平台、无需 root）
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
        source "$HOME/.nvm/nvm.sh"
    fi

    if command -v nvm &>/dev/null; then
        echo "  [INFO] 使用 nvm 安装 Node.js LTS..."
        nvm install --lts
        nvm use --lts
    elif [[ "$OSTYPE" == "darwin"* ]] && command -v brew &>/dev/null; then
        echo "  [INFO] 使用 Homebrew 安装 Node.js..."
        brew install node
    elif command -v apt-get &>/dev/null; then
        echo "  [INFO] 使用 apt 安装 Node.js LTS..."
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif command -v yum &>/dev/null; then
        echo "  [INFO] 使用 yum 安装 Node.js LTS..."
        curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
        sudo yum install -y nodejs
    else
        echo "  [INFO] nvm 未安装，正在下载安装 nvm..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        source "$NVM_DIR/nvm.sh"
        nvm install --lts
        nvm use --lts
    fi

    if ! command -v node &>/dev/null; then
        echo "  [错误] Node.js 自动安装失败，请手动安装：https://nodejs.org"
        exit 1
    fi
    echo "  [OK] Node.js 安装成功：$(node -v)"
fi

NODE_VER=$(node -v)
echo "  ✓ Node.js 版本：$NODE_VER"


# 检查并安装依赖
if [ ! -d "node_modules/express" ]; then
    echo ""
    echo "  ▶ 正在安装依赖（首次运行需要网络，请稍候）..."
    npm install
    echo "  ✓ 依赖安装完成"
fi

# 检查并创建 .env
if [ ! -f ".env" ]; then
    echo ""
    echo "  [提示] 未找到 .env 配置文件，正在从 .env.example 自动生成..."
    cp .env.example .env
    echo "  [警告] 初始化完成！您可以后续在 .env 文件中填入 API Key 及修改配置。"
    echo ""
fi

# 检查并安装 pm2
if ! command -v pm2 &>/dev/null; then
    echo "  ▶ 正在全局安装 pm2（进程管理器，仅首次需要）..."
    npm install -g pm2
    echo "  ✓ pm2 安装完成"
fi

echo ""
echo "  ▶ 启动 WhatsApp Monitor 后台服务..."

# 停止旧进程（如有）
pm2 stop whatsapp-monitor 2>/dev/null || true
pm2 delete whatsapp-monitor 2>/dev/null || true

# 用 pm2 在后台启动，异常自动重启
pm2 start index.js --name whatsapp-monitor --log monitor.log --time

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║  ✅ 已在后台启动！关闭终端不影响运行      ║"
echo "  ╠══════════════════════════════════════════╣"
echo "  ║  🌐 控制台：http://localhost:3000         ║"
echo "  ║  📄 查看日志：pm2 logs whatsapp-monitor   ║"
echo "  ║  ⏹  停止程序：运行 ./stop.sh             ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# 自动打开浏览器
sleep 2
if command -v open &>/dev/null; then
    open "http://localhost:3000"       # macOS
elif command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:3000"   # Linux
fi
