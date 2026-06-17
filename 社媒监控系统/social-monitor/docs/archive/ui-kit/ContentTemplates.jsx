// ContentTemplates.jsx — /templates (内容模板库)
const TEMPLATES = [
  { id: 1, customer: "RocketPay 国际版", type: "OTP验证码", frequency: 8421,
    content: "[RocketPay] Your verification code is {code}. Valid for 5 minutes. Do not share.",
    notes: "需保留品牌名 [RocketPay] 及反钓警示语 'Do not share'" },
  { id: 2, customer: "TechCommerce 跨境", type: "Notification通知", frequency: 1240,
    content: "Hi {name}, your order #{order_id} has been shipped. Tracking: {url}",
    notes: "巴西线路要求 URL 必须 https,墨西哥线路对 emoji 不友好,需移除。" },
  { id: 3, customer: "FinService 收单",   type: "Marketing营销", frequency: 480,
    content: "🎉 限时活动 | {amount} 起即可享受 0 费率,点击领取: {url}\n回复 STOP 退订",
    notes: "营销类必须含退订关键词 (STOP / UNSUBSCRIBE),美国监管要求。" },
  { id: 4, customer: "RocketPay 国际版", type: "OTP验证码", frequency: 3120,
    content: "【火箭支付】您的验证码是 {code},5 分钟内有效,请勿向他人透露。",
    notes: "国内通道需保留【】方括号品牌前缀,运营商规范。" },
  { id: 5, customer: "AppGrow 出海推广", type: "Marketing营销", frequency: 215,
    content: "{name}, your free trial ends in 3 days. Upgrade now: {url}\nReply STOP to unsubscribe.",
    notes: "Trial 通知必须明确剩余天数,A2P 9.0 合规要求。" },
];

function TypeBadge({ type }) {
  const map = { "OTP验证码": "purple", "Marketing营销": "amber", "Notification通知": "indigo", "其他": "slate" };
  return <span className={"tag " + (map[type] || "slate")}>{type}</span>;
}

function ContentTemplates() {
  const [q, setQ] = React.useState("");
  const [customer, setCustomer] = React.useState("全部客户");
  const [type, setType] = React.useState("全部类型");
  const customers = ["全部客户", ...new Set(TEMPLATES.map(t => t.customer))];
  const types = ["全部类型", "OTP验证码", "Marketing营销", "Notification通知", "其他"];
  const visible = TEMPLATES.filter(t =>
    (customer === "全部客户" || t.customer === customer) &&
    (type === "全部类型" || t.type === type) &&
    (!q || t.content.includes(q) || t.notes.includes(q))
  );
  return (
    <div className="view-enter">
      <div className="panel">
        <div className="panel-title">
          <span className="title-text"><span className="panel-icon">📝</span> 内容模板库</span>
          <span className="hint">客服审核对话中自动提取短信模板及合规要点</span>
        </div>
        <div style={{ display: "flex", gap: 12, marginBottom: 22, flexWrap: "wrap" }}>
          <input className="form-control" style={{ flex: 1, minWidth: 220, maxWidth: 320 }}
                 placeholder="搜索模板内容 / 合规备注..." value={q} onChange={e => setQ(e.target.value)} />
          <select className="form-control" value={customer} onChange={e => setCustomer(e.target.value)} style={{ minWidth: 160 }}>
            {customers.map(c => <option key={c}>{c}</option>)}
          </select>
          <select className="form-control" value={type} onChange={e => setType(e.target.value)} style={{ minWidth: 140 }}>
            {types.map(t => <option key={t}>{t}</option>)}
          </select>
          <button className="btn-primary">🔍 搜索</button>
        </div>
        {visible.length === 0 ? <div className="empty-state">输入关键词搜索内容模板</div> :
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {visible.map(t => (
            <div key={t.id} className="msg-card" style={{ flexDirection: "column", gap: 12, alignItems: "stretch" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "var(--t)" }}>{t.customer}</span>
                  <TypeBadge type={t.type} />
                </div>
                <span style={{ fontSize: 12, color: "var(--t3)", fontWeight: 600 }}>命中 {t.frequency.toLocaleString()} 次</span>
              </div>
              <div style={{ background: "var(--bg)", borderRadius: 10, padding: "14px 18px",
                            fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--t)",
                            lineHeight: 1.6, whiteSpace: "pre-wrap", border: "1px solid var(--border)" }}>
                {t.content}
              </div>
              {t.notes && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: "var(--color-warning)", fontWeight: 600 }}>
                  <span>📋</span><span>合规备注: {t.notes}</span>
                </div>
              )}
            </div>
          ))}
        </div>}
      </div>
    </div>
  );
}

window.ContentTemplates = ContentTemplates;
