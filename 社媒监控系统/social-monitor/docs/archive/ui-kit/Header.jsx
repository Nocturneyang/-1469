// Header.jsx — sticky header with title + status pill
const TITLE_MAP = {
  "/":                "全盘态势 Dashboard",
  "/feed":            "原始数据流 Raw Feed",
  "/analytics":       "数据看板 Analytics",
  "/admin/accounts":  "帐号管理 Accounts",
  "/admin/config":    "系统配置 Config",
  "/knowledge":       "QA 知识库",
  "/profiles":        "供应商画像 Supplier Profiles",
  "/devicekb":        "设备知识库 Device KB",
  "/templates":       "内容模板库 Templates",
  "/login":           "登录 Login",
};

function Header({ route }) {
  const title = TITLE_MAP[route] || "Dashboard";
  return (
    <header className="header">
      <div className="header-title">{title}</div>
      <div className="header-actions">
        <span className="status-pill"><span className="pulse"></span> API Server 在线守护</span>
      </div>
    </header>
  );
}

window.Header = Header;
