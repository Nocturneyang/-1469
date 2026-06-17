// KnowledgeBase.jsx — /knowledge route (QA 知识库)
const QA_ITEMS = [
  {
    id: 1, q: "OTP 短信通道兑现率突然跌至 70% 以下,如何快速排查?",
    sector: "支付通道", confidence: 0.92, frequency: 18,
    keywords: ["OTP", "兑现率", "通道故障", "上游网关"],
    steps: [
      "确认是否为单一上游 (Telesign / Sinch / Twilio) 还是多通道同时下跌。",
      "查看 receiver_account 维度数据看板,定位是否单账号问题。",
      "联系上游 OOC 群内技术对接人,索取最近 30 分钟的 DLR 报告。",
      "若上游确认正常,检查我们的提交速率是否超限,触发了发送方限流。",
      "如 P0 持续超过 30 分钟,@ 区域负责人启动备用通道切换流程。"
    ]
  },
  {
    id: 2, q: "设备 SN 编号 A341 系列网关频繁断流,什么型号问题已知?",
    sector: "设备技术", confidence: 0.85, frequency: 12,
    keywords: ["设备故障", "网关", "SN-A341", "断流"],
    steps: [
      "A341 系列在 firmware ≤ 2.1.4 时存在 TCP 长连接 30 分钟超时 bug。",
      "升级到 2.1.7+ 可解决,如设备无法 OTA,建议使用 cron 定时心跳。",
      "新部署的 A341 必须先升级到当前 LTS 2.2.x 再投入生产。"
    ]
  },
  {
    id: 3, q: "WhatsApp 账号封号后,客户群组数据如何快速恢复?",
    sector: "出海业务", confidence: 0.78, frequency: 9,
    keywords: ["封号", "WhatsApp", "数据恢复", "群组"],
    steps: [
      "在「帐号管理」中将原账号标记为 archived,保留历史数据库。",
      "部署新 wa-* 账号,通过区域映射继承原账号的 region 标签。",
      "在被封群组里联系群主,由群主重新拉新账号入群。",
      "切勿用同一 IP / 设备指纹直接重登,会触发风控连坐。"
    ]
  },
  {
    id: 4, q: "Telegram MTProto 用户号触发频控保护,如何安全降速?",
    sector: "数据采集", confidence: 0.88, frequency: 15,
    keywords: ["TG", "MTProto", "频控", "封号风险"],
    steps: [
      "立即切换到保守模式 (daily_limit=500, sleep_min_ms=5000)。",
      "暂停所有历史回溯任务,只保留实时增量监听。",
      "等待 24 小时,期间禁止任何主动消息发送行为。",
      "恢复后逐步上调拉取量,每次增幅 ≤ 30%。"
    ]
  },
];

const SECTORS = ["全部板块", "支付通道", "设备技术", "出海业务", "数据采集", "客服质检"];

function QaCard({ item }) {
  return (
    <div className="msg-card" style={{ flexDirection: "column", gap: 14, alignItems: "stretch" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--t)", lineHeight: 1.4 }}>{item.q}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <span className="tag purple">{item.sector}</span>
            {item.keywords.map(kw => <span key={kw} className="tag slate">{kw}</span>)}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--t3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
            置信度
            <span style={{
              fontSize: 13, fontWeight: 800,
              color: item.confidence >= 0.85 ? "var(--color-success)" : item.confidence >= 0.7 ? "var(--color-warning)" : "var(--color-danger)"
            }}>{Math.round(item.confidence * 100)}%</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--t3)" }}>命中 {item.frequency} 次</div>
        </div>
      </div>
      <div style={{ background: "var(--bg-tint)", borderRadius: 12, padding: "14px 18px",
                    borderLeft: "3px solid var(--p)" }}>
        {item.steps.map((s, i) => (
          <div key={i} style={{ display: "flex", gap: 10, fontSize: 13, color: "var(--t2)",
                                lineHeight: 1.7, padding: "3px 0" }}>
            <span style={{ color: "var(--p)", fontWeight: 800, minWidth: 18 }}>{i + 1}.</span>
            <span>{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function KnowledgeBase() {
  const [q, setQ] = React.useState("");
  const [sector, setSector] = React.useState("全部板块");
  const visible = QA_ITEMS.filter(it =>
    (sector === "全部板块" || it.sector === sector) &&
    (!q || it.q.includes(q) || it.keywords.some(k => k.includes(q)))
  );
  return (
    <div className="view-enter">
      <div className="panel">
        <div className="panel-title">
          <span className="title-text"><span className="panel-icon">📖</span> QA 知识库</span>
          <span className="hint">问题闭环时自动提取 · 高置信度可作 SOP 参考 · 共 {QA_ITEMS.length} 条</span>
        </div>
        <div style={{ display: "flex", gap: 12, marginBottom: 22, flexWrap: "wrap" }}>
          <input className="form-control" style={{ flex: 1, minWidth: 240, maxWidth: 380 }}
                 placeholder="搜索问题/关键词..." value={q} onChange={e => setQ(e.target.value)} />
          <select className="form-control" value={sector} onChange={e => setSector(e.target.value)} style={{ minWidth: 140 }}>
            {SECTORS.map(s => <option key={s}>{s}</option>)}
          </select>
          <button className="btn-primary">🔍 搜索</button>
        </div>
        {visible.length === 0
          ? <div className="empty-state">暂无匹配的知识条目</div>
          : <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {visible.map(it => <QaCard key={it.id} item={it} />)}
            </div>
        }
      </div>
    </div>
  );
}

window.KnowledgeBase = KnowledgeBase;
