// Shell.jsx — top-level layout + route state for all screens
function Shell() {
  const [authed, setAuthed] = React.useState(true);
  const [route, setRoute] = React.useState("/");

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  let view = null;
  switch (route) {
    case "/":                   view = <Dashboard />; break;
    case "/feed":               view = <Feed />; break;
    case "/analytics":          view = <Analytics />; break;
    case "/knowledge":          view = <KnowledgeBase />; break;
    case "/devicekb":           view = <DeviceKB />; break;
    case "/templates":          view = <ContentTemplates />; break;
    case "/profiles":           view = <SupplierProfiles />; break;
    case "/admin/accounts":     view = <Admin />; break;
    case "/admin/config":       view = <AdminConfig />; break;
    default: view = (
      <div className="view-enter">
        <div className="panel">
          <div className="panel-title"><span className="title-text">🚧 待实现</span></div>
          <p style={{ color: "var(--t2)", fontSize: 14 }}>
            未知路由 <code>{route}</code>。返回 left-nav 任一入口。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <Sidebar route={route} onNavigate={setRoute} />
      <main className="main">
        <Header route={route} />
        <div className="content" key={route}>{view}</div>
      </main>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("app"));
root.render(<Shell />);
