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
assert.match(permissionConfigSource, /const result = await saveAdminUserScopes\(userId,/, 'saving service-account scopes must retain the API response');
assert.match(permissionConfigSource, /scopeDraft\.value = toScopeDraft\(scopes\);/, 'saved service-account scopes must immediately refresh the displayed count');
assert.match(permissionConfigSource, /users: users\.value\.map\(\(user\) => \(user\.id === userId \? \{ \.\.\.user, scopes \} : user\)\)/, 'saved service-account scopes must update the selected user state');
assert.match(permissionConfigSource, /if \(!access\.value\.accounts\?\.length\) await load\(\);/, 'adding a scope must refresh newly connected service accounts');
assert.match(permissionConfigSource, /请为每条范围选择平台、服务账号和分组后再保存/, 'empty service-account scopes must not be silently discarded');

console.log('[frontend] component registrations and brand contract verified');
