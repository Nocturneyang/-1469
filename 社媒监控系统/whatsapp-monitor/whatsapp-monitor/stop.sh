#!/bin/bash
echo ""
echo "  ▶ 正在停止 WhatsApp Monitor..."
pm2 stop whatsapp-monitor 2>/dev/null || true
pm2 delete whatsapp-monitor 2>/dev/null || true
echo "  ✅ 已停止。"
