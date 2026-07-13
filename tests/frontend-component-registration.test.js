'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'frontend/src/main.js'), 'utf8');
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

console.log('[frontend] global Element Plus component registrations verified');
