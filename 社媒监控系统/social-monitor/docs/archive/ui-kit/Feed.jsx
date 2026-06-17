// Feed.jsx — /feed route (原始数据流)
const FEED_MESSAGES = [
  { id: 1, p: "wa",  icon: "🟢", group: "东南亚-客服-A 群",        sender: "王经理",     acct: "wa-sales01", time: "16:32:48", text: "网关延迟告警阈值已超 12 分钟,请协助排查上游路由。", media: true },
  { id: 2, p: "tgu", icon: "🟣", group: "支付通道运维",             sender: "林涛",       acct: "tgu-user01", time: "16:30:12", text: "已切到备用节点,等待 5 分钟观察。" },
  { id: 3, p: "tg",  icon: "🔵", group: "OTP-客户审核 Bot",         sender: "bot",        acct: "tg-otp02",   time: "16:28:55", text: "新批次 142 条短信模板已提交审核,合规备注: 4 项需复核。" },
  { id: 4, p: "tm",  icon: "🟦", group: "Regional Ops · APAC",      sender: "Priya M.",   acct: "teams_01",   time: "16:25:09", text: "P1 告警闭环,@运维组 后续可以归档。" },
  { id: 5, p: "wa",  icon: "🟢", group: "华南区·夜班值守",           sender: "小张",       acct: "wa-sales01", time: "16:21:33", text: "今日上报 3 起设备故障,均已转工单。" },
  { id: 6, p: "tgu", icon: "🟣", group: "深圳·锐讯通信群",           sender: "值班工程师", acct: "tgu-user03", time: "16:18:02", text: "网关 SN-A341 重启完成,可恢复路由。", media: true },
  { id: 7, p: "wa",  icon: "🟢", group: "Customer · OTP 通道",      sender: "张老师",     acct: "wa-support02", time: "16:12:41", text: "兑现率掉到 78%,先看看是不是上游网关问题。" },
  { id: 8, p: "tg",  icon: "🔵", group: "告警机器人通知",            sender: "alert-bot",  acct: "tg-otp02",   time: "16:08:25", text: "[P1] tgu-user03 触发频控保护,自动降速。" },
];

const PLATFORMS = [
  { v: "all", label: "全渠道",          icon: "🌈" },
  { v: "wa",  label: "WhatsApp",       icon: "🟢" },
  { v: "tg",  label: "Telegram Bot",   icon: "🔵" },
  { v: "tgu", label: "TG User",        icon: "🟣" },
  { v: "tm",  label: "Microsoft Teams", icon: "🟦" },
];

function Feed() {
  const [pf, setPf] = React.useState("all");
  const [q, setQ] = React.useState("");
  const visible = FEED_MESSAGES.filter(m => (pf === "all" || m.p === pf) && (!q || m.text.includes(q) || m.group.includes(q)));
  return (
    <div className="view-enter">
      <div className="panel">
        <div className="panel-title">
          <span className="title-text"><span className="panel-icon">💬</span> 原始消息流</span>
          <span className="hint">滚动窗口 · 自动 10s 刷新 · 共 {FEED_MESSAGES.length} 条</span>
        </div>
        <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
          <input className="form-control" style={{ flex: 1, minWidth: 220, maxWidth: 360 }}
                 placeholder="搜索群组 / 消息内容 / 发送人..." value={q} onChange={e => setQ(e.target.value)} />
          <button className="btn-secondary">🔍 搜索</button>
        </div>
        <div className="filters">
          {PLATFORMS.map(f => (
            <button key={f.v}
                    className={"f-btn" + (pf === f.v ? " active" : "")}
                    onClick={() => setPf(f.v)}>
              {f.icon} {f.label}
            </button>
          ))}
        </div>
        {visible.length === 0 ? (
          <div className="empty-state">暂无消息数据</div>
        ) : visible.map(m => (
          <div key={m.id} className="msg-card">
            <div className="msg-avatar">{m.icon}</div>
            <div className="m-body">
              <div className="m-head">
                <span className="m-group">{m.group}</span>
                <span className="m-sender">@{m.sender}</span>
                <span className="m-acct">{m.acct}</span>
                <span className="m-time">{m.time}</span>
              </div>
              <div className="m-text">{m.text}</div>
              {m.media && <div className="m-media">📎 含媒体附件 <a href="#" onClick={e => e.preventDefault()}>查看</a></div>}
            </div>
          </div>
        ))}
        <div className="pagination">
          <button disabled>上一页</button>
          <button className="active">1</button>
          <button>2</button>
          <button>3</button>
          <button>4</button>
          <button>下一页</button>
        </div>
      </div>
    </div>
  );
}

window.Feed = Feed;
