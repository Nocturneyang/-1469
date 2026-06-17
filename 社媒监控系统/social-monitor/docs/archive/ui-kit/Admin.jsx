// Admin.jsx — /admin/accounts route (帐号管理)
const ACCOUNTS = [
  { id: "wa-sales01",   platform: "WhatsApp",                 icon: "🟢", status: "online", statusText: "在线",
    pushname: "Sales · APAC #01", today: "1,284", groups: "12",  uptime: "47d" },
  { id: "tgu-user01",   platform: "TG 用户号",                 icon: "🟣", status: "warmup", statusText: "预热中🟡",
    pushname: "+86 138****0123",  today: "486",   groups: "42",  uptime: "保守" },
  { id: "bot_otp02",    platform: "TG 机器人",                 icon: "🔵", status: "online", statusText: "在线",
    pushname: "OTP Audit Bot",    today: "2,012", groups: "8",   uptime: "112d" },
  { id: "teams-apac",   platform: "Teams",                    icon: "🟦", status: "err",    statusText: "Session失效🔴",
    pushname: "rocketglobal.onmicrosoft.com", today: "0",       groups: "3", uptime: "—" },
  { id: "wa-support02", platform: "WhatsApp",                 icon: "🟢", status: "online", statusText: "在线",
    pushname: "Support · CN",     today: "642",   groups: "9",   uptime: "23d" },
  { id: "tgu-user03",   platform: "TG 用户号",                 icon: "🟣", status: "warmup", statusText: "预热中🟡",
    pushname: "+86 137****6688",  today: "204",   groups: "28",  uptime: "激进" },
  { id: "wa-mkt03",     platform: "WhatsApp",                 icon: "🟢", status: "qr",     statusText: "待扫码",
    pushname: "—",                today: "0",     groups: "0",   uptime: "—" },
  { id: "bot_notif01",  platform: "TG 机器人",                 icon: "🔵", status: "online", statusText: "在线",
    pushname: "Notify Bot",       today: "1,876", groups: "5",   uptime: "89d" },
];

function AccountCard({ a }) {
  const isTgu = a.id.startsWith("tgu-");
  const isTeams = a.platform === "Teams";
  return (
    <div className="acc-card">
      <div className={"acc-status " + a.status}>{a.statusText}</div>
      <div className="acc-icon">{a.icon}</div>
      <div className="acc-name">{a.platform}</div>
      <div className="acc-id">{a.id}</div>
      {a.pushname !== "—" && <div className="acc-push">{a.pushname}</div>}

      <div className="acc-stats-row">
        <div className="acc-stat-cell"><div className="lbl">今日入库</div><div className="val">{a.today}</div></div>
        <div className="acc-stat-cell"><div className="lbl">监控群组</div><div className="val">{a.groups}</div></div>
        <div className="acc-stat-cell"><div className="lbl">{isTgu ? "频控" : "运行"}</div><div className="val">{a.uptime}</div></div>
      </div>

      <div className="card-actions">
        {isTgu ? (
          <>
            <button className="el-btn primary">频控</button>
            <button className="el-btn primary">监控群聊</button>
            <button className="el-btn success">回溯</button>
            <button className="el-btn danger">撤销</button>
          </>
        ) : isTeams ? (
          <>
            <button className="el-btn primary">登录引导</button>
            <button className="el-btn danger">删除</button>
          </>
        ) : (
          <>
            <button className="el-btn warning">下线</button>
            <button className="el-btn primary">重登</button>
            <button className="el-btn danger">删除</button>
          </>
        )}
      </div>
    </div>
  );
}

function DeployModal({ onClose }) {
  const [tab, setTab] = React.useState("wa");
  const tabs = [
    { v: "wa",    label: "WhatsApp" },
    { v: "tg",    label: "Telegram Bot" },
    { v: "teams", label: "Teams" },
    { v: "tgu",   label: "TG 个人号" },
  ];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>新增终端设备</h3>
        <div className="sub">选择采集渠道,部署一个新的监控终端节点。</div>

        <div className="tabs">
          {tabs.map(t => (
            <div key={t.v} className={"tab" + (tab === t.v ? " active" : "")} onClick={() => setTab(t.v)}>{t.label}</div>
          ))}
        </div>

        {tab === "wa" && (
          <div className="field-group">
            <div>
              <label className="field-label">设备标识符 (只能为英文和数字)</label>
              <input className="field-input" placeholder="例如: sales_01" />
            </div>
          </div>
        )}
        {tab === "tg" && (
          <div className="field-group">
            <div>
              <label className="field-label">设备标识符</label>
              <input className="field-input" placeholder="bot_01" />
            </div>
            <div>
              <label className="field-label">Bot Token (向 BotFather 申请)</label>
              <input className="field-input" placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
            </div>
          </div>
        )}
        {tab === "teams" && (
          <div className="field-group">
            <div>
              <label className="field-label">设备标识符</label>
              <input className="field-input" placeholder="teams_01" />
            </div>
          </div>
        )}
        {tab === "tgu" && (
          <>
            <div className="alert-error">⚠️ 严重警告: 个人号接口抓取极易封号,请配置低频拉取并使用老号!</div>
            <div className="field-group">
              <div>
                <label className="field-label">账号名称 (不含 tgu- 前缀)</label>
                <input className="field-input" placeholder="例如: user01" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label className="field-label">API ID</label>
                  <input className="field-input" placeholder="API ID" />
                </div>
                <div>
                  <label className="field-label">API Hash</label>
                  <input className="field-input" placeholder="API Hash" />
                </div>
              </div>
              <div>
                <label className="field-label">登录手机号 (含国家代码)</label>
                <input className="field-input" placeholder="+8613800138000" />
              </div>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button className="btn-primary">📱 {tab === "tgu" ? "发送验证码" : "部署终端"}</button>
        </div>
      </div>
    </div>
  );
}

function Admin() {
  const [modal, setModal] = React.useState(false);
  const onlineCount = ACCOUNTS.filter(a => a.status === "online").length;
  const errCount    = ACCOUNTS.filter(a => a.status === "err").length;
  return (
    <div className="view-enter">
      <div className="panel">
        <div className="panel-title">
          <span className="title-text"><span className="panel-icon">👥</span> 采集帐号池</span>
          <span className="hint">{ACCOUNTS.length} 终端 · {onlineCount} 在线 · {errCount} 故障</span>
          <button className="btn-primary title-action" onClick={() => setModal(true)}>+ 新增帐号系统</button>
        </div>
        <div className="grid-acc">
          {ACCOUNTS.map(a => <AccountCard key={a.id} a={a} />)}
        </div>
      </div>
      {modal && <DeployModal onClose={() => setModal(false)} />}
    </div>
  );
}

window.Admin = Admin;
