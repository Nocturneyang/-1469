# 2026-07-06 工作台人工标签/分组开发记录

## 目标

生产工作台需要支持对群进行工作台人工标签。同步到账号的 WA/TG 标签、文件夹或分组仍作为渠道分组只读展示；工作台人工标签用于会话筛选、查看、分派和权限授权，不写回 WA/TG 原生分组。

## 实现

- `service_groups` 增加 `parent_native_group_id`、`group_level`、`is_manual`、`created_by`、`updated_by` 字段。
- 人工一级分组使用 `source = manual_l1`，人工二级分组使用 `source = manual_l2`。
- 会话人工分组映射复用 `conversation_service_group_map`，但保存时只替换人工映射，不动 WA/TG 同步映射。
- 渠道同步清理只清理非人工来源，避免同步刷新时误删人工分组。
- 权限判断支持父级人工分组覆盖其二级子分组。
- 工作台右侧会话详情新增“工作台标签”选择和创建入口，新建标签后自动打到当前会话。
- 会话详情将“工作台标签”和“渠道分组”分开展示，避免把工作台自有标签误认为 WA/TG 原生分组。
- 顶部筛选、会话列表和权限矩阵继续复用同一映射，但展示文案统一为“标签/分组”。

## 边界

- 不修改 WA 原生标签或 TG 文件夹。
- 不写 `database.sqlite`，不修改 `messages` 表。
- 不读取分析库，不调用 AI、告警、画像、知识资产模块。
- 工作台标签创建和会话打标需要 `can_manage`。
- 工作台标签保存在工作台自己的 `service_groups` / `conversation_service_group_map`，不写 `raw.sqlite`，也不写渠道 session。

## 部署注意

旧 `workbench.sqlite` 会在 `openWorkbenchDb()` 时自动迁移新增列。上线前需要确认生产服务使用新版代码启动过一次，之后再验证工作台人工分组接口。
