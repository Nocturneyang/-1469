// Login.jsx — /login route (登录页)
function Login({ onLogin }) {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  const submit = (e) => {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      onLogin && onLogin(username);
    }, 700);
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg)", padding: 20,
      backgroundImage: "radial-gradient(circle at 20% 10%, rgba(107,70,193,0.10) 0%, transparent 40%), radial-gradient(circle at 80% 90%, rgba(159,122,234,0.10) 0%, transparent 40%)"
    }}>
      <div style={{ width: 440, maxWidth: "100%" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 28 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 20,
            background: "linear-gradient(135deg, #ede9fe, #d6bcfa)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 36, marginBottom: 16,
            boxShadow: "0 8px 24px rgba(107,70,193,0.2)"
          }}>🔮</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--t)", letterSpacing: "-0.3px" }}>Social Monitor</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--t3)", letterSpacing: 1.2, textTransform: "uppercase", marginTop: 4 }}>DATA PIPELINE</div>
        </div>

        <form onSubmit={submit} style={{
          background: "#fff", border: "1px solid var(--border)", borderRadius: "var(--r)",
          padding: 32, boxShadow: "0 10px 40px rgba(0,0,0,0.08)"
        }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 4px 0", color: "var(--t)" }}>欢迎回来</h2>
          <p style={{ fontSize: 13, color: "var(--t3)", margin: "0 0 24px 0" }}>登录到 社媒监控系统 操作台</p>

          <div className="field-group">
            <div>
              <label className="field-label">账号</label>
              <input className="field-input" placeholder="Username"
                     value={username} onChange={e => setUsername(e.target.value)} autoFocus />
            </div>
            <div>
              <label className="field-label">密码</label>
              <input className="field-input" type="password" placeholder="Password"
                     value={password} onChange={e => setPassword(e.target.value)} />
            </div>
          </div>

          <button type="submit" className="btn-primary" disabled={loading}
                  style={{ width: "100%", padding: "12px", justifyContent: "center", marginBottom: 12, opacity: loading ? 0.7 : 1 }}>
            {loading ? "登录中…" : "登录 / Login"}
          </button>

          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--t3)", marginTop: 12 }}>
            <a href="#" style={{ color: "var(--p)", fontWeight: 600, textDecoration: "none" }} onClick={e => e.preventDefault()}>忘记密码?</a>
            <span>v3.2.1 · 内部使用</span>
          </div>
        </form>

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 11, color: "var(--t3)" }}>
          © 2025 Social Monitor · 仅供授权用户访问
        </div>
      </div>
    </div>
  );
}

window.Login = Login;
