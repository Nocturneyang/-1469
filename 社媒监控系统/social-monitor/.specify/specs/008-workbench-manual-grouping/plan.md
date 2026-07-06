# 工作台人工分组技术方案

## 数据模型

人工分组复用 `workbench.sqlite.service_groups`，并增加层级字段：

- `parent_native_group_id`：二级分组父级 ID，一级为空。
- `group_level`：`1` 或 `2`。
- `is_manual`：人工分组标记。
- `source`：人工一级为 `manual_l1`，人工二级为 `manual_l2`。

会话与人工分组映射继续写入 `conversation_service_group_map`。人工映射和渠道同步映射共享读取路径，但写入来源分离。

## API

- `GET /api/workbench/manual-groups`：列出当前可见服务账号下人工分组。
- `POST /api/workbench/manual-groups`：新建人工一级或二级分组，需要 `can_manage`。
- `PUT /api/workbench/groups/:groupId/manual-groups`：保存当前会话人工分组，需要当前会话 `can_manage`。

既有接口增强：

- `GET /api/workbench/channel-labels` 返回人工分组层级字段。
- `GET /api/workbench/groups` 的 `label_id` 过滤支持一级人工分组命中其二级子分组。

## 权限

- 超级管理员维持全量能力。
- 普通坐席只能在已授权服务账号和分组范围内查看。
- `can_manage` 控制人工分组创建和会话打标。
- 对人工二级分组命中的会话，拥有父级一级分组权限的坐席视为拥有对应能力。

## 同步保护

渠道同步仍可重建 WA/TG 同步分组及映射，但删除/清空时必须保留 `manual`、`manual_l1`、`manual_l2` 来源的 `service_groups` 和 `conversation_service_group_map`。

## 前端

- 右侧会话详情新增人工分组选择与新建入口。
- 顶部分组筛选展示同步分组和人工分组来源。
- 会话列表展示二级人工分组时带父级名称。
- 权限管理矩阵展示人工一级/二级来源文本。

## 影响范围

- `workbench/db/schema.sql`
- `workbench/db/workbench-db.js`
- `workbench/lib/channel-sync-store.js`
- `workbench/lib/permissions.js`
- `workbench/server/routes/workbench.js`
- `workbench/frontend/src/*`
- `social-monitor/routes/workbench-permissions.js`
- `social-monitor/frontend/src/views/WorkbenchPermissions.vue`
