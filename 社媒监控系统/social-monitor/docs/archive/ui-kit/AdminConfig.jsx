// AdminConfig.jsx — /admin/config (系统配置)
function ConfigPanel({ icon, title, hint, action, children }) {
  return (
    <div className="panel">
      <div className="panel-title">
        <span className="title-text"><span className="panel-icon">{icon}</span> {title}</span>
        {hint && <span className="hint">{hint}</span>}
        {action && <button className="btn-primary title-action">{action}</button>}
      </div>
      {children}
    </div>
  );
}

function AdminConfig() {
  return (
    <div className="view-enter">
      <ConfigPanel icon="🔬" title="分析引擎运行摘要" hint="analytics.sqlite · 实时">
        <div className="grid-4">
          <div className="stat-card" style={{ position: "relative", padding: "20px 18px" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--p)" }}></div>
            <div className="stat-lbl">累计告警</div>
            <div className="stat-val" style={{ color: "var(--p)", fontSize: 32 }}>1,284</div>
          </div>
          <div className="stat-card" style={{ position: "relative", padding: "20px 18px" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--color-danger)" }}></div>
            <div className="stat-lbl">P0 紧急</div>
            <div className="stat-val" style={{ color: "var(--color-danger)", fontSize: 32 }}>11</div>
          </div>
          <div className="stat-card" style={{ position: "relative", padding: "20px 18px" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--color-warning)" }}></div>
            <div className="stat-lbl">P1 聚合</div>
            <div className="stat-val" style={{ color: "var(--color-warning)", fontSize: 32 }}>51</div>
          </div>
          <div className="stat-card" style={{ position: "relative", padding: "20px 18px" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--color-success)" }}></div>
            <div className="stat-lbl">已闭环</div>
            <div className="stat-val" style={{ color: "var(--color-success)", fontSize: 32 }}>85</div>
          </div>
        </div>
      </ConfigPanel>

      <WebhookConfig />

      <ConfigPanel icon="🤖" title="AI 环境变量" hint="模型 / API Key / Prompt 模板">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
          {[
            { k: "AI_MODEL",        v: "claude-haiku-4-5" },
            { k: "AI_API_KEY",      v: "sk-ant-***[已设置]" },
            { k: "AI_TEMPERATURE",  v: "0.2" },
            { k: "PROMPT_DIGEST",   v: "[已自定义]" },
          ].map(env => (
            <div key={env.k} style={{ background: "var(--bg-tint)", borderRadius: 12, padding: 14,
                                      border: "1px solid var(--border)" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--t3)",
                            fontWeight: 600, marginBottom: 6 }}>{env.k}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--t)",
                            fontWeight: 600, wordBreak: "break-all" }}>{env.v}</div>
            </div>
          ))}
        </div>
      </ConfigPanel>

      <ConfigPanel icon="👥" title="内部员工白名单" hint="系统据此过滤内部消息">
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ background: "var(--bg-tint)", border: "1px solid var(--border)",
                        borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--t2)", marginBottom: 8,
                          textTransform: "uppercase", letterSpacing: 0.5 }}>精确匹配 (Whitelist)</div>
            <div style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.7 }}>
              王经理、林涛、张老师、Priya M.、小张、值班工程师、bot-alert、bot-digest
            </div>
          </div>
          <div style={{ background: "var(--bg-tint)", border: "1px solid var(--border)",
                        borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--t2)", marginBottom: 8,
                          textTransform: "uppercase", letterSpacing: 0.5 }}>模糊匹配关键词</div>
            <div style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.7 }}>
              运维、客服、技术、@bot、admin、ops、support
            </div>
          </div>
        </div>
      </ConfigPanel>

      <ConfigPanel icon="🗺️" title="区域账号映射" hint="告警路由依赖此配置" action="+ 新增映射">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0 8px", fontSize: 13 }}>
            <thead>
              <tr style={{ fontSize: 10, fontWeight: 800, color: "var(--t3)", textTransform: "uppercase", letterSpacing: 1 }}>
                <th style={{ padding: "0 14px 4px", textAlign: "left" }}>账号 ID</th>
                <th style={{ padding: "0 14px 4px", textAlign: "left" }}>平台</th>
                <th style={{ padding: "0 14px 4px", textAlign: "left" }}>业务板块</th>
                <th style={{ padding: "0 14px 4px", textAlign: "left" }}>区域</th>
                <th style={{ padding: "0 14px 4px", textAlign: "left" }}>价值标签</th>
                <th style={{ padding: "0 14px 4px", textAlign: "left" }}>负责人</th>
                <th style={{ padding: "0 14px 4px", textAlign: "center" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {[
                { id: "wa-sales01",    pf: "WHATSAPP", sec: "支付通道", region: "华南区", label: "L0", owner: "王经理" },
                { id: "tgu-user01",    pf: "TGU",      sec: "出海业务", region: "东南亚", label: "L0", owner: "林涛" },
                { id: "bot_otp02",     pf: "TG",       sec: "支付通道", region: "全球",   label: "L1", owner: "张老师" },
                { id: "teams-apac",    pf: "TEAMS",    sec: "出海业务", region: "APAC",   label: "L1", owner: "Priya M." },
                { id: "wa-support02",  pf: "WHATSAPP", sec: "客服质检", region: "华南区", label: "L2", owner: "小张" },
              ].map(r => (
                <tr key={r.id} style={{ background: "#fff", border: "1px solid var(--border)" }}>
                  <td style={{ padding: "12px 14px" }}><code style={{ fontSize: 11 }}>{r.id}</code></td>
                  <td style={{ padding: "12px 14px" }}>
                    <span style={{ background: "var(--bg)", color: "var(--t2)", padding: "2px 8px",
                                   borderRadius: 6, fontSize: 11, fontWeight: 700 }}>{r.pf}</span>
                  </td>
                  <td style={{ padding: "12px 14px", color: "var(--t2)" }}>{r.sec}</td>
                  <td style={{ padding: "12px 14px", fontWeight: 700, color: "var(--t)" }}>{r.region}</td>
                  <td style={{ padding: "12px 14px" }}>
                    <span className={"tag " + (r.label === "L0" ? "red" : r.label === "L1" ? "amber" : "slate")}
                          style={{ fontWeight: 700 }}>{r.label}</span>
                  </td>
                  <td style={{ padding: "12px 14px", color: "var(--t2)" }}>{r.owner}</td>
                  <td style={{ padding: "12px 14px", textAlign: "center" }}>
                    <button className="el-btn" style={{ marginRight: 6 }}>编辑</button>
                    <button className="el-btn danger">删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ConfigPanel>
    </div>
  );
}

window.AdminConfig = AdminConfig;
