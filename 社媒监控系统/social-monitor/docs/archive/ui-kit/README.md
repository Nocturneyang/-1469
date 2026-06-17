# Social Monitor — UI Kit

High-fidelity click-thru recreation of the Soft-UI shell with three core screens.

## What's in here

- `index.html` — host page. Loads React 18 + Babel and stitches the kit together. Visit it directly.
- `Sidebar.jsx` — fixed 280px neumorphic sidebar with brand block, nav, user badge
- `Header.jsx` — sticky blurred header + live status pill
- `Shell.jsx` — top-level `<Sidebar />` + `<Header />` + content slot, handles route state
- `Dashboard.jsx` — `/` route. Stat-card grid + activity placeholder
- `Feed.jsx` — `/feed` route. Filter pills + message-card stream
- `Admin.jsx` — `/admin/accounts` route. Account card grid + "+ deploy" CTA
- `tokens.css` — pulls `../../colors_and_type.css` and adds kit-only utilities

## What you can do

Click between the three nav items to switch screens. On Feed, click the platform filter pills to filter the (faked) message list. On Admin, click the **+ 新增帐号系统** button to open a deploy modal.

## What's intentionally faked

- All data is hard-coded
- The TG-User multi-step login wizard is not implemented (just the first step is shown in the modal)
- Routes are managed by local state, not Vue Router

## What's intentionally pixel-perfect

- 280px sidebar width, fixed; `margin-left: 280px` content
- Sticky header with `backdrop-filter: blur(12px)` and `rgba(224, 229, 236, 0.85)`
- Neumorphic double-shadow on all cards; recessed in-shadow on the active nav item
- Page transition: 400ms fade + translateY(15px) using `cubic-bezier(0.16, 1, 0.3, 1)`
- Pulse animation on the API-online dot (2s infinite)
- Bilingual page titles (`全盘态势 Dashboard`, etc.)
- Emoji as primary iconography
