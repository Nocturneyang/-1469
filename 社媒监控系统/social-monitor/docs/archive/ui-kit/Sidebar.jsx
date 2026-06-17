// Sidebar.jsx — 260px white sidebar with grouped nav
function Sidebar({ route, onNavigate, user = "ops_admin" }) {
  const sections = [
    {
      title: "实时监控",
      items: [
        { path: "/",        label: "全盘态势",   icon: "📊" },
        { path: "/feed",    label: "原始数据流", icon: "💬", badge: 12 },
        { path: "/analytics", label: "数据看板", icon: "📈" },
      ],
    },
    {
      title: "知识资产",
      items: [
        { path: "/knowledge",  label: "QA 知识库",   icon: "📖" },
        { path: "/devicekb",   label: "设备知识库",  icon: "🔧" },
        { path: "/templates",  label: "内容模板库",  icon: "📝" },
        { path: "/profiles",   label: "供应商画像",  icon: "🏷️" },
      ],
    },
    {
      title: "系统管理",
      items: [
        { path: "/admin/accounts", label: "帐号管理", icon: "👥" },
        { path: "/admin/config",   label: "系统配置", icon: "⚙️" },
      ],
    },
  ];
  const isActive = (p) => p === "/" ? route === "/" : route.startsWith(p);
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="glyph">🔮</div>
        <div className="brand-text">
          <span className="brand-name">Social Monitor</span>
          <span className="brand-tagline">Data Pipeline</span>
        </div>
      </div>
      <nav className="nav">
        {sections.map((sec, i) => (
          <React.Fragment key={i}>
            <div className="nav-section">{sec.title}</div>
            {sec.items.map(item => (
              <a key={item.path}
                 className={"nav-item" + (isActive(item.path) ? " active" : "")}
                 onClick={(e) => { e.preventDefault(); onNavigate(item.path); }}
                 href="#">
                <span className="nav-icon">{item.icon}</span>
                <span>{item.label}</span>
                {item.badge && <span className="nav-badge">{item.badge}</span>}
              </a>
            ))}
          </React.Fragment>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="user-badge">
          <span className="user-avatar">{user.charAt(0).toUpperCase()}</span>
          <span className="user-name">{user}</span>
          <span className="logout">退出</span>
        </div>
      </div>
    </aside>
  );
}

window.Sidebar = Sidebar;
