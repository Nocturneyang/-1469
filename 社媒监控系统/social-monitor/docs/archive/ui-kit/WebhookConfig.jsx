// WebhookConfig.jsx — 钉钉机器人 Webhook 二级目录配置
// 4 types: ALERT (业务告警) / DIGEST (日报) / WEEKLY (周报) / OPS (系统运维)
// Each can have: global fallback + per-platform-per-region overrides
// Priority chain: 区域专属 → 平台兜底 → 全局配置
// Note: useState is already destructured by Dashboard.jsx into the shared
// Babel global scope, so we don't redeclare it here.

// Demo state — in real Vue code this comes from envConfig + regionWebhooks props
const INITIAL_ENV = {
  DINGTALK_ALERT:      "https://oapi.dingtalk.com/robot/send?access_token=alert_abc***",
  DINGTALK_DIGEST:     "https://oapi.dingtalk.com/robot/send?access_token=digest_xyz***",
  DINGTALK_WEEKLY:     "",
  DINGTALK_SYSTEM_OPS: "https://oapi.dingtalk.com/robot/send?access_token=ops_ops***",
};
const INITIAL_REGIONS = {
  "ALERT_wa_华南区":   { url: "https://oapi.dingtalk.com/robot/send?access_token=wa_cn_south_***", comment: "王经理 / 张老师" },
  "ALERT_wa_华北区":   { url: "https://oapi.dingtalk.com/robot/send?access_token=wa_cn_north_***", comment: "李工" },
  "ALERT_tgu_东南亚":  { url: "https://oapi.dingtalk.com/robot/send?access_token=tgu_sea_***",    comment: "林涛 (Mason)" },
  "ALERT_teams_APAC":  { url: "https://oapi.dingtalk.com/robot/send?access_token=teams_apac_***",  comment: "Priya M." },
  "DIGEST_wa_华南区":  { url: "https://oapi.dingtalk.com/robot/send?access_token=digest_cn_***",   comment: "" },
  "DIGEST_tgu_东南亚": { url: "https://oapi.dingtalk.com/robot/send?access_token=digest_sea_***",  comment: "" },
  "WEEKLY_wa_华南区":  { url: "https://oapi.dingtalk.com/robot/send?access_token=weekly_cn_***",   comment: "供应商评分专属" },
};

const PLATFORM_LABELS = { wa: "WhatsApp", tg: "Telegram Bot", tgu: "TG 用户号", teams: "Teams" };
const PLATFORM_ICONS  = { wa: "🟢", tg: "🔵", tgu: "🟣", teams: "🟦" };

const ALERT_ROWS = [
  { tag: null,  tagClass: null,  label: "通用告警 全局配置 (最终兜底)", hint: null,                                   key: "DINGTALK_ALERT" },
  { tag: "P0",  tagClass: "p0",  label: "严重业务中断",                  hint: "通道故障/0% 送达率,直接触发",          key: "DINGTALK_ALERT_P0" },
  { tag: "P1",  tagClass: "p1",  label: "业务异常告警",                  hint: "5 分钟窗口聚合 + AI 评分 ≥ 7",         key: "DINGTALK_ALERT_P1" },
  { tag: "P2",  tagClass: "p2",  label: "无响应告警",                    hint: "外部问题 15 分钟内未回复",             key: "DINGTALK_ALERT_P2" },
  { tag: "SID", tagClass: "sid", label: "SID 变更告警",                  hint: "3 个以上节点批量更新",                 key: "DINGTALK_ALERT_SID" },
];

const AVAILABLE_REGIONS = [
  { region: "华南区",   account: "wa-sales01"   },
  { region: "华北区",   account: "wa-support02" },
  { region: "华东区",   account: "wa-mkt03"     },
  { region: "东南亚",   account: "tgu-user01"   },
  { region: "APAC",     account: "teams-apac"   },
  { region: "全球",     account: "bot_otp02"    },
];

// =============================================================================
//                              SUB-COMPONENTS
// =============================================================================

function WebhookGroup({ icon, title, hint, color, isOpen, onToggle, statusText, statusKind, children }) {
  return (
    <div className="wh-group">
      <div className={"wh-group-header" + (isOpen ? " open" : "")} onClick={onToggle}>
        <div className="wh-hdr-left">
          <span className="wh-hdr-icon" style={{ background: color + "22", color: color }}>{icon}</span>
          <div>
            <div className="wh-hdr-title">{title}</div>
            <div className="wh-hdr-hint">{hint}</div>
          </div>
        </div>
        <div className="wh-hdr-right">
          {statusText && (
            <span className={"wh-status " + statusKind}>{statusText}</span>
          )}
          <span className="wh-arrow">▶</span>
        </div>
      </div>
      {isOpen && <div className="wh-group-body">{children}</div>}
    </div>
  );
}

function WebhookRow({ tag, tagClass, label, hint, isSet, onEdit, onClear }) {
  return (
    <div className="wh-cli">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="wh-cli-row">
          {tag && <span className={"wh-tag " + tagClass}>{tag}</span>}
          <span className="wh-cli-label">{label}</span>
          <span className={"wh-cli-badge " + (isSet ? "set" : "")}>
            {isSet ? "✓ 已配置" : "未配置"}
          </span>
        </div>
        {hint && <div className="wh-cli-hint">{hint}</div>}
      </div>
      <div className="wh-cli-actions">
        <button className="wh-btn-text" onClick={onEdit}>编辑</button>
        {isSet && <button className="wh-btn-text danger" onClick={onClear}>清空</button>}
      </div>
    </div>
  );
}

function RegionRow({ platform, region, value, onView, onDelete }) {
  const url = (value && value.url) || "";
  const comment = (value && value.comment) || "";
  return (
    <div className="wh-region-row">
      <span className="wh-region-platform">{PLATFORM_ICONS[platform]}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="wh-region-name">
          {region}
          {comment && <span className="wh-region-owner">@ {comment}</span>}
        </div>
        <div className="wh-region-url">{url.length > 60 ? url.slice(0, 55) + "..." : url}</div>
      </div>
      <div className="wh-cli-actions">
        <button className="wh-btn-text" onClick={onView}>查看</button>
        <button className="wh-btn-text danger" onClick={onDelete}>删除</button>
      </div>
    </div>
  );
}

function PlatformGroup({ platform, regions, tagClass, onView, onDelete }) {
  return (
    <>
      <div className="wh-platform-header">
        <span className={"wh-tag " + tagClass}>{platform.toUpperCase()}</span>
        <span className="wh-platform-name">{PLATFORM_LABELS[platform]} 平台</span>
        <span className="wh-platform-count">· {Object.keys(regions).length} 个区域</span>
      </div>
      {Object.entries(regions).map(([region, val]) => (
        <RegionRow key={region} platform={platform} region={region} value={val}
                   onView={() => onView(val, region, platform)}
                   onDelete={() => onDelete(platform, region)} />
      ))}
    </>
  );
}

// =============================================================================
//                                  MODALS
// =============================================================================

function EditModal({ title, initialUrl, initialSecret, onClose, onSave }) {
  const [url, setUrl]       = useState(initialUrl || "");
  const [secret, setSecret] = useState(initialSecret || "");
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 500 }}>
        <h3>编辑 {title}</h3>
        <div className="sub">钉钉机器人 Webhook 配置 · 仅运维管理员可见</div>
        <div className="field-group">
          <div>
            <label className="field-label">Webhook URL</label>
            <input className="field-input" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
                   value={url} onChange={e => setUrl(e.target.value)} />
          </div>
          <div>
            <label className="field-label">加签 Secret <span style={{ color: "var(--t3)", fontWeight: 500 }}>(可选)</span></label>
            <input className="field-input" placeholder="SEC..."
                   value={secret} onChange={e => setSecret(e.target.value)} />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={() => { onSave(url, secret); onClose(); }}>保存</button>
        </div>
      </div>
    </div>
  );
}

function RegionModal({ typeLabel, onClose, onSave }) {
  const [platform, setPlatform] = useState("wa");
  const [regions, setRegions]   = useState([]);
  const [url, setUrl]           = useState("");
  const [secret, setSecret]     = useState("");
  const [comment, setComment]   = useState("");
  const toggle = (r) => setRegions(rs => rs.includes(r) ? rs.filter(x => x !== r) : [...rs, r]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 520 }}>
        <h3>新增 {typeLabel} 区域 Webhook</h3>
        <div className="sub">为特定平台 + 区域配置专属推送通道。优先级最高,覆盖全局兜底。</div>
        <div className="field-group">
          <div>
            <label className="field-label">生效平台</label>
            <select className="field-input" value={platform} onChange={e => setPlatform(e.target.value)}>
              {Object.entries(PLATFORM_LABELS).map(([k, v]) => <option key={k} value={k}>{PLATFORM_ICONS[k]} {v}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">生效区域 <span style={{ color: "var(--t3)", fontWeight: 500 }}>(可多选)</span></label>
            <div className="wh-region-picker">
              {AVAILABLE_REGIONS.map(r => (
                <label key={r.region} className="wh-region-check">
                  <input type="checkbox" checked={regions.includes(r.region)} onChange={() => toggle(r.region)} />
                  <span style={{ fontWeight: 600, color: "var(--t)" }}>{r.region}</span>
                  <code style={{ fontSize: 11 }}>{r.account}</code>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="field-label">Webhook URL</label>
            <input className="field-input" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
                   value={url} onChange={e => setUrl(e.target.value)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label className="field-label">加签 Secret <span style={{ color: "var(--t3)", fontWeight: 500 }}>(可选)</span></label>
              <input className="field-input" placeholder="SEC..." value={secret} onChange={e => setSecret(e.target.value)} />
            </div>
            <div>
              <label className="field-label">备注 <span style={{ color: "var(--t3)", fontWeight: 500 }}>(可选)</span></label>
              <input className="field-input" placeholder="如: 王经理 / 区域负责人" value={comment} onChange={e => setComment(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={!url || regions.length === 0}
                  onClick={() => { onSave(platform, regions, url, secret, comment); onClose(); }}>
            保存配置
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
//                                MAIN PANEL
// =============================================================================

function WebhookConfig() {
  const [open, setOpen]   = useState({ ALERT: true, DIGEST: false, WEEKLY: false, OPS: false });
  const [env, setEnv]     = useState(INITIAL_ENV);
  const [regs, setRegs]   = useState(INITIAL_REGIONS);
  const [editM, setEditM] = useState(null);   // { key, title }
  const [regM, setRegM]   = useState(null);   // { type, label }
  const toggle = (k) => setOpen(o => ({ ...o, [k]: !o[k] }));

  const isSet = (key) => !!env[key];
  const setEnv1 = (key, url) => setEnv(e => ({ ...e, [key]: url }));
  const clearEnv = (key)     => setEnv(e => ({ ...e, [key]: "" }));

  const grouped = (type) => {
    const out = {};
    for (const k of Object.keys(regs)) {
      if (!k.startsWith(type + "_")) continue;
      const rest = k.slice(type.length + 1);
      const idx = rest.indexOf("_");
      if (idx < 0) continue;
      const platform = rest.slice(0, idx);
      const region   = rest.slice(idx + 1);
      out[platform] = out[platform] || {};
      out[platform][region] = regs[k];
    }
    return out;
  };

  const summary = (type, globalKey) => {
    const grp = grouped(type);
    const regionCount = Object.values(grp).reduce((n, p) => n + Object.keys(p).length, 0);
    const platformCount = Object.keys(grp).length;
    const hasGlobal = globalKey && isSet(globalKey);
    if (regionCount === 0 && !hasGlobal) return { text: "未配置", kind: "off" };
    if (regionCount === 0)               return { text: "✓ 全局兜底", kind: "ok" };
    return { text: `${regionCount} 区域 · ${platformCount} 平台` + (hasGlobal ? " · 含兜底" : ""), kind: "active" };
  };

  // Status pulses for header summary across all 4 channels
  const totalRegions = Object.keys(regs).length;
  const totalGlobals = Object.keys(env).filter(k => env[k]).length;

  return (
    <div className="panel">
      <div className="panel-title">
        <span className="title-text"><span className="panel-icon">🔔</span> 钉钉机器人 Webhook</span>
        <span className="hint">二级目录 · 优先级 区域专属 → 平台兜底 → 全局配置 · {totalGlobals} 全局 / {totalRegions} 区域</span>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {["ALERT", "DIGEST", "WEEKLY", "OPS"].map(t => {
          const s = t === "OPS" ? summary("OPS", "DINGTALK_SYSTEM_OPS") : summary(t, "DINGTALK_" + t);
          return (
            <button key={t} className="f-btn" onClick={() => setOpen(o => ({ ...o, [t]: !o[t] }))}
                    style={open[t] ? { borderColor: "var(--p)", color: "var(--p)" } : {}}>
              {({ ALERT: "🚨 业务告警", DIGEST: "📋 日报", WEEKLY: "📊 周报", OPS: "🔧 系统运维" })[t]}
              <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.7, fontWeight: 600 }}>{s.text}</span>
            </button>
          );
        })}
      </div>

      {/* 业务告警 */}
      <WebhookGroup
        icon="🚨" color="#e53e3e"
        title="业务告警"
        hint="P0/P1/P2/SID 实时推送 · 触发条件参见 AI 评分规则"
        isOpen={open.ALERT} onToggle={() => toggle("ALERT")}
        {...({ ...summary("ALERT", "DINGTALK_ALERT"), statusText: summary("ALERT", "DINGTALK_ALERT").text, statusKind: summary("ALERT", "DINGTALK_ALERT").kind })}
      >
        {ALERT_ROWS.map(r => (
          <WebhookRow key={r.key + r.tag} {...r}
                      isSet={isSet(r.key)}
                      onEdit={() => setEditM({ key: r.key, title: r.label })}
                      onClear={() => clearEnv(r.key)} />
        ))}
        {Object.entries(grouped("ALERT")).map(([p, rs]) => (
          <PlatformGroup key={p} platform={p} regions={rs} tagClass="p0"
                         onView={(v) => alert("URL: " + v.url + (v.comment ? "\n备注: " + v.comment : ""))}
                         onDelete={(plat, reg) => setRegs(r => { const c = { ...r }; delete c["ALERT_" + plat + "_" + reg]; return c; })} />
        ))}
        <button className="wh-btn-add" onClick={() => setRegM({ type: "ALERT", label: "业务告警" })}>+ 新增区域专属推送</button>
      </WebhookGroup>

      {/* 日报 */}
      <WebhookGroup
        icon="📋" color="#3182ce"
        title="日报"
        hint="每日 09:00 群汇总 · 含 P0/P1 复盘 + 供应商动态"
        isOpen={open.DIGEST} onToggle={() => toggle("DIGEST")}
        statusText={summary("DIGEST", "DINGTALK_DIGEST").text} statusKind={summary("DIGEST", "DINGTALK_DIGEST").kind}
      >
        <WebhookRow label="全局配置 (兜底)" isSet={isSet("DINGTALK_DIGEST")}
                    onEdit={() => setEditM({ key: "DINGTALK_DIGEST", title: "日报全局配置" })}
                    onClear={() => clearEnv("DINGTALK_DIGEST")} />
        {Object.entries(grouped("DIGEST")).map(([p, rs]) => (
          <PlatformGroup key={p} platform={p} regions={rs} tagClass="digest"
                         onView={(v) => alert("URL: " + v.url)}
                         onDelete={(plat, reg) => setRegs(r => { const c = { ...r }; delete c["DIGEST_" + plat + "_" + reg]; return c; })} />
        ))}
        <button className="wh-btn-add" onClick={() => setRegM({ type: "DIGEST", label: "日报" })}>+ 新增区域专属推送</button>
      </WebhookGroup>

      {/* 周报 */}
      <WebhookGroup
        icon="📊" color="#38a169"
        title="周报"
        hint="每周一 09:00 供应商评分 + 趋势对比"
        isOpen={open.WEEKLY} onToggle={() => toggle("WEEKLY")}
        statusText={summary("WEEKLY", "DINGTALK_WEEKLY").text} statusKind={summary("WEEKLY", "DINGTALK_WEEKLY").kind}
      >
        <WebhookRow label="全局配置 (兜底)" isSet={isSet("DINGTALK_WEEKLY")}
                    onEdit={() => setEditM({ key: "DINGTALK_WEEKLY", title: "周报全局配置" })}
                    onClear={() => clearEnv("DINGTALK_WEEKLY")} />
        {Object.entries(grouped("WEEKLY")).map(([p, rs]) => (
          <PlatformGroup key={p} platform={p} regions={rs} tagClass="weekly"
                         onView={(v) => alert("URL: " + v.url)}
                         onDelete={(plat, reg) => setRegs(r => { const c = { ...r }; delete c["WEEKLY_" + plat + "_" + reg]; return c; })} />
        ))}
        <button className="wh-btn-add" onClick={() => setRegM({ type: "WEEKLY", label: "周报" })}>+ 新增区域专属推送</button>
      </WebhookGroup>

      {/* 系统运维 */}
      <WebhookGroup
        icon="🔧" color="#d69e2e"
        title="系统运维"
        hint="WA/TG/TGU/Teams 账号掉线 · Session 过期 · 进程崩溃告警"
        isOpen={open.OPS} onToggle={() => toggle("OPS")}
        statusText={summary("OPS", "DINGTALK_SYSTEM_OPS").text} statusKind={summary("OPS", "DINGTALK_SYSTEM_OPS").kind}
      >
        <div className="wh-tip">
          💡 建议单独建一个「运维通知群」,接收全平台账号掉线 / Session 过期 / 进程崩溃告警。该通道不区分平台与区域。
        </div>
        <WebhookRow label="全平台统一通道" hint="所有 WA/TG/TGU/Teams 节点共用此推送"
                    isSet={isSet("DINGTALK_SYSTEM_OPS")}
                    onEdit={() => setEditM({ key: "DINGTALK_SYSTEM_OPS", title: "系统运维 Webhook" })}
                    onClear={() => clearEnv("DINGTALK_SYSTEM_OPS")} />
      </WebhookGroup>

      {editM && <EditModal title={editM.title} initialUrl={env[editM.key] || ""}
                           onClose={() => setEditM(null)}
                           onSave={(url) => setEnv1(editM.key, url)} />}
      {regM  && <RegionModal typeLabel={regM.label}
                             onClose={() => setRegM(null)}
                             onSave={(platform, regions, url, secret, comment) => {
                               setRegs(r => {
                                 const c = { ...r };
                                 for (const region of regions) c[regM.type + "_" + platform + "_" + region] = { url, secret, comment };
                                 return c;
                               });
                             }} />}
    </div>
  );
}

window.WebhookConfig = WebhookConfig;
