# Workbench Manual Grouping API

所有接口前缀为 `/api/workbench`，均写入 `workbench.sqlite`，不修改渠道原生标签、TG 文件夹或 `database.sqlite`。

## GET `/manual-groups`

查询参数：

- `platform`：可选，`wa`、`tg`、`teams`。
- `account`：可选，单个服务账号。
- `accounts`：可选，逗号分隔的 `platform:account` 列表。

返回：

```json
{
  "ok": true,
  "groups": [
    {
      "platform": "wa",
      "service_account": "nanya_wa",
      "native_group_id": "manual:l1",
      "name": "售后支持",
      "source": "manual_l1",
      "parent_native_group_id": null,
      "group_level": 1,
      "is_manual": 1
    }
  ]
}
```

## POST `/manual-groups`

权限：服务账号 `can_manage`。

请求：

```json
{
  "platform": "wa",
  "account": "nanya_wa",
  "name": "VIP 客户",
  "group_level": 2,
  "parent_native_group_id": "manual:parent"
}
```

规则：

- `group_level` 只能是 `1` 或 `2`。
- 二级分组必须指定同平台、同服务账号下的人工一级父分组。
- `name` 会做长度和空白字符清洗。

## PUT `/groups/:groupId/manual-groups`

权限：当前会话 `can_manage`。

请求：

```json
{
  "platform": "wa",
  "account": "nanya_wa",
  "manual_group_ids": ["manual:child"]
}
```

行为：

- 替换当前会话已有人工分组映射。
- 保留当前会话已有 WA/TG 同步分组映射。
- 返回当前会话所有分组标签，用于前端局部刷新。

返回：

```json
{
  "ok": true,
  "labels": [
    {
      "native_group_id": "manual:child",
      "name": "VIP 客户",
      "source": "manual_l2",
      "parent_native_group_id": "manual:parent",
      "parent_name": "售后支持",
      "group_level": 2,
      "is_manual": 1
    }
  ]
}
```
