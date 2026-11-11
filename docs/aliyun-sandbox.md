# 阿里云 Agent Sandbox 极速版

`SANDBOX_PROVIDER=aliyun` 使用固定版本 `e2b@2.31.0`，与 CubeProvider 并列实现
SandboxProvider。默认生产 Provider 仍为 `cube`；demo 模式只接受 `demo`。
API 和所有 Worker 必须使用相同的 Provider、存储和 Skill 配置。

## 接口依据

- [Cube 开发者入口](https://cubesandbox.com/dev/)及其指向的
  [Node.js SDK 文档](https://cubesandbox.com/guide/tutorials/sdk/nodejs)。现有 Cube SDK、Volume 和只读挂载保持兼容。
- [阿里云 E2B 兼容说明](https://help.aliyun.com/zh/agent-sandbox/e2b-compatibility-explanation)：
  官方推荐 2.31.0，并提示 2.51.0 的 create/connect 兼容问题；本项目精确固定版本。
- [SDK 参数](https://help.aliyun.com/zh/agent-sandbox/e2b-sdk-integration-parameter-description)：
  API Key、API URL、数据面 domain、template 和毫秒超时分别配置，不复用 Cube 参数。
- [网络](https://help.aliyun.com/zh/agent-sandbox/network/)：
  同时设置 `secure: true` 和 `network.allowPublicTraffic: false`。
  commands/files 的 `envdAccessToken` 由 SDK 在 connect 后自动携带；
  用户服务端口使用的 `trafficAccessToken` 返回并持久化，但不替代 envd 鉴权。
- [动态挂载 OSS](https://help.aliyun.com/zh/agent-sandbox/mount-oss-dynamically-1)：
  使用 `fc.sandbox.storage.oss`、`fc.sandbox.auth.role` metadata，
  不调用暂不兼容的 E2B Volume API。

## 配置与准备

准备同地域的极速版 API Key、模板、OSS Bucket 和 RAM Role。
模板必须包含 Python 3、bash 和指定的非 root 用户；OSS 挂载必须允许该用户读写工作区。
RAM Role 需要允许函数计算扮演，并具备指定 OSS 前缀的权限。不要给沙箱不需要的 Bucket 权限。

```dotenv
SANDBOX_PROVIDER=aliyun
E2B_API_KEY=<控制台创建的 Key>
E2B_API_URL=https://api.cn-hangzhou.sandbox.aliyuncs.com
E2B_DOMAIN=cn-hangzhou.sandbox.aliyuncs.com
ALIYUN_TEMPLATE_ID=pi-flow-v1
ALIYUN_EXEC_USER=user
ALIYUN_TIMEOUT_MS=900000
ALIYUN_OSS_BUCKET=my-pi-flow-bucket
ALIYUN_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
ALIYUN_OSS_ROLE_ARN=acs:ram::1234567890123456:role/pi-flow-sandbox
ALIYUN_OSS_WORKSPACE_PREFIX=/pi-flow/workspaces
ALIYUN_ALLOW_INTERNET_ACCESS=false
ALIYUN_NETWORK_JSON={}
SKILL_BUNDLES_JSON={"default":"default"}
SKILL_VOLUMES_JSON={}
ALIYUN_SKILLS_JSON={}
```

数据库、模型网关、认证等公共生产配置仍然必需。阿里云模式不要求任何 `CUBE_*` 配置。
私网或自定义域名需同时配置匹配的 `E2B_API_URL` 和 `E2B_DOMAIN`，并确保 API/Worker 可访问。
创建、连接和删除均显式传递端点，不通过全局修改 SDK 配置切换云厂商。

`ALIYUN_NETWORK_JSON` 只接受 `allowOut`、`denyOut` 字符串数组，不能覆盖入站鉴权。
`ALIYUN_ALLOW_INTERNET_ACCESS` 只接受 `true`/`false`，默认 `false`。
这两项按阿里云网络文档共同生效；白名单和禁用出网组合的实际效果需在目标地域验证。
这些是部署级配置，不会自动把 Agent 策略转换成逐任务规则。

## 持久化和 Skill

每个工作区仅挂载 `<workspacePrefix>/ws-<workspaceId>` 到 `/workspace`。
存储标识包含 Bucket、Endpoint 和前缀的摘要；传入 Cube Volume ID 或另一套 OSS 配置的标识会被拒绝。
释放实例、超时回收、Skill 选择变化、文件 API 临时实例均复用这个前缀。
实例的 connect 延长可用时间；单次命令上限 130 秒，实例超时最小为 180 秒。

只读 Skill 使用同一 Bucket 中单独、不可变的版本目录，必须先发布 `SKILL.md` 和辅助文件：

```dotenv
ALIYUN_SKILLS_JSON={"review@v1":{"bundle":"default","path":"/skills/review/v1/SKILL.md","bucketPath":"/pi-flow/skills/review/v1"}}
```

该 ID、bundle、path 必须与平台 Skill 注册记录一致，SKILL.md 内容须匹配其 digest。
只挂载本次选择的版本，读权限、目录身份和 digest 在创建及工具执行前检查。
工作区和 Skill 的 OSS 前缀不得重叠。
缺失挂载、可写 Skill 挂载或摘要不匹配均拒绝执行，并尝试删除创建失败的实例；
删除未确认时保留容量占用，供现有生命周期清理逻辑处理。

控制台 ZIP 上传仍写到平台 hostPath，本次不实现自动上传 OSS。
带 hostUpload 标记的 Skill 会明确返回 `ALIYUN_SKILL_NOT_PUBLISHED`，不能假装云端已挂载。
应通过现有配置导入发布无 hostUpload 的 Skill 记录，并在 OSS 中配置对应版本。

## 生命周期边界

| 操作 | 阿里云适配行为 |
| --- | --- |
| 创建、连接、工具执行、删除实例 | E2B SDK；非零命令退出与 Cube 统一转换为工具错误 |
| 工作区持久化 | OSS 子目录动态挂载；不创建 E2B Volume |
| 暂停 | 返回 409 `SANDBOX_PAUSE_UNSUPPORTED`，不会改变容量状态 |
| 空闲回收 | 到 `SANDBOX_IDLE_PAUSE_SECONDS` 即释放实例；下次按相同 OSS 前缀重建 |
| 快照、恢复 | 返回 409 `SANDBOX_SNAPSHOT_UNSUPPORTED` |
| 快照克隆 | 不支持；不承诺外部 OSS 数据随运行时快照复制 |
| 删除工作区 | 删除实例及平台记录；保留外部 OSS 数据，按 Bucket 生命周期或运维流程清理 |

本适配器没有启用需白名单的暂停/快照，即使账号已开通也不会默认调用。
OSS 是对象存储挂载，不能承诺完整 POSIX、数据库文件锁或强一致的并发写入语义。
上线前必须运行下述真实账号测试，验证当前模板/挂载实现支持工具使用的原子替换和 fsync。
跨多个实例读写的缓存可见性、性能和业务依赖的文件系统语义需另外验收。

切换 Provider 不会迁移已有工作区：先停止 API/Worker，备份和迁移文件，
使用新工作区和云端 Skill 发布记录。不要让不同 Provider 的 Worker 同时处理同一部署。

## 验证

```bash
npm run check
npm test
# 在已导出上述真实账号环境变量的终端中执行（会创建计费实例）：
npm run smoke:aliyun
```

冒烟脚本通过实际远程工具写入、删除首个实例、重建、读取并编辑同一文件，
再删除测试文件并释放实例；使用唯一工作区前缀，不操作已有数据。
异常时仍尝试清理实例；失败写入的测试文件和空前缀可能需要人工清理。
仓库测试使用 SDK mock 验证协议、只读挂载、隔离、错误映射、失败清理和空闲生命周期，
不代表已经通过真实阿里云账号或 Cube 集群联调。
