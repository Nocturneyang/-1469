# Access Control API Contract

所有接口要求已登录，并要求 `admin:access:manage` 权限。

## GET `/api/admin/access-control/permissions`

返回系统权限项字典。

```json
{
  "success": true,
  "data": [
    {
      "code": "monitor:view",
      "category": "monitor",
      "name": "查看监控系统",
      "description": "访问监控看板、分析结果和知识资产只读页面"
    }
  ]
}
```

## GET `/api/admin/access-control/roles`

返回角色及其权限项。

```json
{
  "success": true,
  "data": [
    {
      "code": "monitor_viewer",
      "name": "监控只读",
      "is_system": 1,
      "permissions": ["monitor:view"]
    }
  ]
}
```

## POST `/api/admin/access-control/roles`

创建自定义角色。

```json
{
  "code": "regional_manager",
  "name": "区域主管",
  "description": "区域业务主管",
  "permissions": ["monitor:view", "workbench:view"]
}
```

## PUT `/api/admin/access-control/roles/:code/permissions`

替换角色权限项。

```json
{
  "permissions": ["monitor:view", "monitor:assets:write"]
}
```

## GET `/api/admin/access-control/operators`

返回授权对象、角色、有效权限和入口权限。

## PUT `/api/admin/access-control/operators/:operatorId`

保存授权对象角色和入口权限。

```json
{
  "display_name": "Alice",
  "roles": ["monitor_viewer", "agent"],
  "portal_access": {
    "can_monitor": true,
    "can_workbench": true,
    "can_admin": false,
    "default_entry": "chooser"
  }
}
```
