#!/bin/bash
cd "$(dirname "$0")"

echo "正在关闭所有的后台采集进程..."
npx pm2 stop all

echo "✅ 系统已完全停止工作！"
# 给双击运行预留 3 秒缓冲时间以便阅读
sleep 3
