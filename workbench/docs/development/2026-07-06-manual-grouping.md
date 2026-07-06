# 2026-07-06 工作台人工分组开发记录

## 目标

生产工作台需要支持对群进行人工标签或分组。同步到账号的 WA/TG 分组仍作为渠道一级分组；人工侧可维护一级分组和二级分组，用于会话筛选、分派和权限授权。

## 实现

- `service_groups` 增加 `parent_native_group_id`、`group_level`、`is_manual`、`created_by`、`updated_by` 字段。
- 人工一级分组使用 `source = manual_l1`，人工二级分组使用 `source = manual_l2`。
- 会话人工分组映射复用 `conversation_service_group_map`，但保存时只替换人工映射，不动 WA/TG 同步映射。
- 渠道同步清理只清理非人工来源，避免同步刷新时误删人工分组。
- 权限判断支持父级人工分组覆盖其二级子分组。
- 工作台右侧会话详情新增人工分组选择和创建入口。
- 顶部分组筛选、会话列表和监控系统权限矩阵增加人工分组来源展示。

## 边界

- 不修改 WA 原生标签或 TG 文件夹。
- 不写 `database.sqlite`，不修改 `messages` 表。
- 不读取分析库，不调用 AI、告警、画像、知识资产模块。
- 人工分组创建和会话打标需要 `can_manage`。

## 部署注意

旧 `workbench.sqlite` 会在 `openWorkbenchDb()` 时自动迁移新增列。上线前需要确认生产服务使用新版代码启动过一次，之后再验证工作台人工分组接口。
