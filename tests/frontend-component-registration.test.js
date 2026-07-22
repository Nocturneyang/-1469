'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'frontend/src/main.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const railSource = fs.readFileSync(path.join(root, 'frontend/src/components/ServiceAccountRail.vue'), 'utf8');
const topFiltersSource = fs.readFileSync(path.join(root, 'frontend/src/components/TopFilters.vue'), 'utf8');
const permissionConfigSource = fs.readFileSync(path.join(root, 'frontend/src/components/PermissionConfig.vue'), 'utf8');
const serviceAccountAccessSource = fs.readFileSync(path.join(root, 'frontend/src/components/ServiceAccountAccess.vue'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'frontend/src/styles.css'), 'utf8');
const componentDir = path.join(root, 'frontend/src/components');
const componentSources = fs.readdirSync(componentDir)
  .filter((name) => name.endsWith('.vue'))
  .map((name) => fs.readFileSync(path.join(componentDir, name), 'utf8'))
  .join('\n');

const requiredRegistrations = {
  'el-popover': 'ElPopover',
};

for (const [tagName, registrationName] of Object.entries(requiredRegistrations)) {
  if (!componentSources.includes(`<${tagName}`)) continue;
  assert.match(
    mainSource,
    new RegExp(`\\b${registrationName}\\b`),
    `${tagName} is used but ${registrationName} is not registered in frontend/src/main.js`,
  );
}

for (const source of [indexSource, railSource, topFiltersSource]) {
  assert.ok(source.includes('社媒服务工作台'), 'product name must be 社媒服务工作台');
}
assert.ok(railSource.includes('<ChatLineSquare />'), 'brand must use the service conversation mark');
assert.match(stylesSource, /\.brand-presence-dot\s*\{/, 'brand must expose the online service status motif');
assert.ok(indexSource.includes('href="/favicon.svg"'), 'site must expose the branded favicon');
assert.ok(indexSource.includes('property="og:image" content="/share-preview.png"'), 'shared links must expose a branded Open Graph image');
assert.ok(fs.existsSync(path.join(root, 'frontend/public/share-preview.png')), 'shared-link preview image must be a committed public asset');
assert.match(permissionConfigSource, /if \(!access\.value\.accounts\?\.length\) await refreshScopeOptions\(\);/, 'adding a scope must refresh newly connected service accounts without replacing user drafts');
assert.match(permissionConfigSource, /access\.value\.accounts = refreshed\.accounts \|\| \[\];/, 'scope-option refresh must preserve the selected user object');
assert.match(permissionConfigSource, /请为每条范围选择平台、服务账号和分组后再保存/, 'empty service-account scopes must not be silently discarded');
assert.ok(!permissionConfigSource.includes('<h2>入口权限</h2>'), 'entry access must no longer be configured separately');
assert.ok(permissionConfigSource.includes('默认入口：工作台'), 'permission management must show the fixed default entry');
assert.ok(!permissionConfigSource.includes('保存全部'), 'permission management must not expose a page-level global save action');
assert.ok(permissionConfigSource.includes('保存当前账户'), 'the selected account card must expose its own save action');
assert.ok(permissionConfigSource.includes('保存角色权限'), 'global role permissions must expose an independent save action');
assert.match(permissionConfigSource, /@click="selectUser\(user\.id\)"/, 'account switching must go through the unsaved-change guard');
assert.ok(permissionConfigSource.includes('当前账户存在未保存修改'), 'account switching must warn before discarding drafts');
assert.match(permissionConfigSource, /const result = await saveAdminUserAccess\(userId,/, 'account save must use the atomic access API');
assert.ok(!permissionConfigSource.includes('role_permissions: Object.fromEntries'), 'account save must not include global role permission drafts');
assert.match(permissionConfigSource, /scopes: scopeDraft\.value\.map/, 'account save must include service-account scopes');
assert.match(permissionConfigSource, /await saveRolePermissions\(role\.code,/, 'role permissions must save through their dedicated API');
assert.ok(serviceAccountAccessSource.includes('退出登录'), 'service accounts must expose a logout-only action');
assert.ok(serviceAccountAccessSource.includes('彻底删除'), 'service accounts must expose a permanent deletion action');
assert.match(serviceAccountAccessSource, /await ElMessageBox\.confirm\([\s\S]*await ElMessageBox\.confirm\(/, 'permanent account deletion must require two confirmations');
assert.ok(serviceAccountAccessSource.includes('所有历史消息及配置都会永久删除且无法恢复'), 'permanent deletion must name the full destructive scope');
assert.match(serviceAccountAccessSource, /confirm_delete_history:\s*true/, 'permanent deletion must send the backend confirmation guard');

console.log('[frontend] component registrations and brand contract verified');
