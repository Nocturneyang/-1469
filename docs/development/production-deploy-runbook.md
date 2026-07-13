# 工作台生产部署流程

日期：2026-07-10

本文记录 `social-workbench` 的生产迭代部署流程。工作台是独立项目，所有代码、部署配置、测试记录和运行资料只使用 `/Users/a2026/Desktop/工作台/`，不得触碰或复用监控项目目录。

## 固定信息

- 本地项目根目录：`/Users/a2026/Desktop/工作台`
- Git 部署工作树：`/Users/a2026/Desktop/工作台/.deploy-worktree`
- Deploy Hub 配置：
  - `.deployhub/deploy.yaml`
  - `.deployhub/k8s/app.yaml`
- 服务名：`social-workbench`
- 命名空间：`g1469`
- 生产域名：`https://social-workbench.tyhark.com`
- 部署分支：`codex/social-workbench-deploy`
- Deploy Hub 拉取仓库：`git@codeup.aliyun.com:69ce4998405bafb07e12686f/skyline-tc/social-workbench.git`

`.deployhub/deploy.yaml` 必须保持：

```yaml
name: social-workbench
namespace: g1469
domain: social-workbench.tyhark.com
sso: true
```

`sso: true` 是 Deploy Hub 公网服务合规要求。工作台应用内的用户、角色、入口权限、服务账号授权范围、会话数据和运行态仍由工作台自己的 SQLite 管理，不与监控项目共用登录、权限、数据库或 worker。

## 部署前检查

1. 先阅读 `AGENTS.md` 和 `DEVELOPMENT_GUIDE.md`，确认改动只发生在工作台目录内。
2. 确认 `.deployhub/deploy.yaml` 和 `.deployhub/k8s/app.yaml` 存在。
3. 确认 Deploy Hub MCP 地址是最新地址：

```text
https://skyline-ark-deploy-hub-mcp.tyhark.com/mcp
```

4. 检查 SSO 对接仍存在：
   - 前端有 401 / 无效 403 后跳转 SSO 的逻辑。
   - 后端有 `/token/userinfo` 或 SSO token 校验逻辑。
   - 未接入 SSO 时禁止部署。
5. 检查部署配置中的 `secretKeyRef`。新增非 optional secret 时，必须先通过 Deploy Hub secret 管理写入；不要把 secret 值写入代码、文档、日志或对话。

## 本地验证

在项目根目录或部署工作树运行：

```bash
npm run build
npm test
```

如果改动涉及 CommonJS 后端、worker 或库文件，按需追加：

```bash
node --check <file>
```

构建中出现 `@vueuse/core` 的 `INVALID_ANNOTATION` 或 chunk 体积提醒时，只要构建退出码为 0，可视为当前已知警告；不要把它当作本次部署失败。

## 同步到部署工作树

日常开发通常先改 `/Users/a2026/Desktop/工作台`，生产提交必须落到 `.deploy-worktree`。

部署前必须运行：

```bash
npm run predeploy:check
```

检查会执行干净安装、依赖树校验、测试、生产构建、生产依赖审计、数据库路径边界检查，以及根目录与 `.deploy-worktree` 内容一致性检查。任何差异都会阻止部署。

生产数据备份使用独立 `/backups` 挂载。Kubernetes CronJob 每日执行 `npm run backup:daily`（保留 7 份），每周执行 `npm run backup:weekly`（保留 4 份）。恢复命令只写临时目录：

```bash
WORKBENCH_RESTORE_STAGE_DIR=/data/restore-staging npm run restore:stage -- /backups/daily/<snapshot>
```

通过 `integrity_check` 并人工核对后，才允许在停机窗口显式切换数据库；脚本不会替换在线文件。

对本次修改过的文件执行同步，例如：

```bash
rsync -a frontend/src/App.vue .deploy-worktree/frontend/src/App.vue
rsync -a frontend/src/components/ConversationList.vue .deploy-worktree/frontend/src/components/ConversationList.vue
rsync -a frontend/src/styles.css .deploy-worktree/frontend/src/styles.css
rsync -a docs/development/<file>.md .deploy-worktree/docs/development/<file>.md
```

同步后在 `.deploy-worktree` 中检查差异：

```bash
git status --short
git diff --stat
git diff
```

## 提交和推送

在 `/Users/a2026/Desktop/工作台/.deploy-worktree` 中提交：

```bash
git add <changed-files>
git commit -m "<type>: <summary>"
```

生产部署必须推送到 Codeup：

```bash
git push codeup codex/social-workbench-deploy
```

如果需要同步备份到 GitHub，可额外推送：

```bash
git push origin codex/social-workbench-deploy
```

Deploy Hub 只依赖 Codeup 仓库；如果只推送到 `origin`，生产不会拿到最新代码。

## Deploy Hub 发布

通过 Deploy Hub MCP 执行迭代部署：

```text
get_deployment_guide({ mode: "iterate" })
deploy({
  repo_url: "git@codeup.aliyun.com:69ce4998405bafb07e12686f/skyline-tc/social-workbench.git",
  branch: "codex/social-workbench-deploy"
})
```

部署返回 `task_id` 后，检查服务日志和 Pod 状态：

```text
logs({
  service_name: "social-workbench",
  namespace: "g1469",
  lines: 120
})
```

成功标准：

- Pod `phase` 为 `Running`。
- 容器 `ready` 为 `true`。
- `restart_count` 没有持续增长。
- `has_errors` 为 `false`。
- 日志中能看到 API/UI、login worker、account supervisor 启动。

## 上线后外部检查

未登录访问生产首页应跳转到 skyline-ark-sso：

```bash
curl -I https://social-workbench.tyhark.com/
```

期望返回 `302`，`Location` 指向：

```text
https://skyline-ark-sso.tyhark.com/login?redirect=...
```

运行配置应可直接读取：

```bash
curl -I https://social-workbench.tyhark.com/runtime-config.js
```

期望返回 `200 OK`。配置内容应保持 `ssoEnabled: true`。

未登录访问工作台 API 返回 `401 Unauthorized` 是预期行为，表示 SSO 保护生效，不代表 API 不可用。

## 常见问题

- 页面仍显示旧 UI：先强制刷新浏览器；生产静态资源和 CDN 可能有短暂缓存。
- 首次访问提示“工作台 API 暂不可用”：优先检查前端是否已拿到 SSO token、`/token/userinfo` 是否成功、后端是否对无效 403 做重新登录引导。
- WA 登录或采集异常：优先查看 `social-workbench-login-worker` 和 `social-workbench-account-supervisor` 日志，确认 Chromium 预检、profile 锁清理、账号 worker lease 和容器内存。
- 需要验证登录后的真实页面时，必须使用已有 SSO 登录态的浏览器会话；未登录的 `curl` 只能验证网关跳转和公开运行配置。

## 禁止事项

- 不提交 `.env`、token、session、SQLite、WAL/SHM 或生产消息导出。
- 不把 secret 原文写入文档、提交信息、日志或对话。
- 不修改 `/Users/a2026/Desktop/社媒监控/`。
- 不绕过工作台 runtime worker 直接操作 WA/TG session。
- 不在工作台 API 请求线程里持有渠道 client。
