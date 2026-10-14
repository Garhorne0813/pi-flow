# 管理控制台

[English](admin-console.md) · [README](../README.zh-CN.md)

服务启动后访问 [管理控制台](http://127.0.0.1:8080/admin/ui)（兼容 `/admin/agents/ui`），输入管理员 Bearer Token 即可连接。

- **Agents**：创建、查看、复制与发布不可变版本，选择工具、Skills、MCP 和子 Agent，管理启停和用户访问范围。指定用户模式至少填写一个用户；扩大到全租户访问需要确认。拒绝所有用户访问请禁用版本。
- **Skills**：上传单 Skill ZIP 并自动登记到共享 hostPath，或登记已有部署的不可变 Skill 版本、查看 Bundle / 路径 / 摘要，以及启用和禁用版本。更新内容需登记新版本 ID。
- **MCP Servers**：从租户已获授权的 Endpoint 中登记服务，设置工具白名单、启停和检查连接。检查仅发现白名单工具，不执行工具；空白名单不授权任何工具。
- **子 Agent 委派**：查看版本之间的委派关系、并发上限和最大深度，打开父 Agent 复制为新版本以调整委派配置。
- **全局配置**：查看当前租户获批模型、可用 Bundles / Endpoints 和 Sandbox 策略；保存租户范围的新建 Agent 默认模型、工具和运行限制。默认值仅用于新草稿，不修改已发布版本或历史会话。未编辑的表单会随刷新更新为其他管理员的新值；未保存的草稿会保留，并在服务器值变化时提示冲突，支持明确放弃草稿并重新载入。保存时服务端在事务内校验预期修订号；过期写入返回 409，保留草稿供重新载入或明确确认后重试。

页面与 API 同源，不需要独立前端构建；HTML 外壳无需认证，所有管理数据操作仍检查管理员权限。令牌仅在页面内存中使用，不保存到浏览器存储或 URL。断开连接会取消未完成请求并清除页面数据。生产使用具备 `harness-admin` 角色的 UCS JWT；本地 Demo 使用 `DEV_TOKEN`。

部署配置（模型凭证、Skill 卷、MCP Endpoint、租户授权与 Sandbox 策略）在控制台中只读，由服务端配置后重启相关 API / Worker 生效；控制台不返回凭证或 Endpoint URL。手动登记 Skill 前需部署文件；ZIP 上传会自动安装文件。MCP Endpoint 仍需先配置。租户默认值在生产中保存在数据库，Demo 中保存在内存，重启后重置。配置修改通过新 AgentVersion 发布，页面不是聊天前端。

完整接口见 [API 文档](api.md#管理控制台)。

### 上传 Skill ZIP

打开 Skills，填写版本 ID（如 `review@v1`）、名称、可选描述与获授权 Bundle，选择 ZIP 后点击“上传并登记版本”。ZIP 包含一个 `SKILL.md`，位于根目录或唯一顶层 Skill 目录内，并可附带 scripts / references。无需填写宿主路径或 SHA-256；上传后可立即在 Agent 的 Skills 中选择新版本并发布。

ZIP 最大 10 MiB、解压后最大 32 MiB、最多 1000 个文件。失败会保留表单和文件选择，成功后清空上传表单；保存成功但列表刷新失败会明确提示，可刷新数据查看。已有版本 ID 不可覆盖，更新请换新 ID。部署需要 API 对共享根目录下 `uploads/` 的写权限，详见[部署文档](deployment.md#skill-zip-uploads--技能-zip-上传)。上传入口被禁用时仍可展开“登记已有部署版本”。
