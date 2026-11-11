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
ALIYUN_NETWORK_JSON={"allowOut":["my-pi-flow-bucket.oss-cn-hangzhou.aliyuncs.com"]}
SKILL_BUNDLES_JSON={"default":"default"}
SKILL_VOLUMES_JSON={}
ALIYUN_SKILLS_JSON={}
```

数据库、模型网关、认证等公共生产配置仍然必需。阿里云模式不要求任何 `CUBE_*` 配置。
私网或自定义域名需同时配置匹配的 `E2B_API_URL` 和 `E2B_DOMAIN`，并确保 API/Worker 可访问。
创建、连接和删除均显式传递端点，不通过全局修改 SDK 配置切换云厂商。

`ALIYUN_NETWORK_JSON` 只接受 `allowOut`、`denyOut` 字符串数组，不能覆盖入站鉴权。
`ALIYUN_ALLOW_INTERNET_ACCESS` 只接受 `true`/`false`，默认 `false`。
按[官方网络访问控制文档](https://help.aliyun.com/zh/agent-sandbox/network-access-control)，默认拒绝可以通过 allowOut 白名单放行。Provider 自动将 `<Bucket>.<Endpoint hostname>` 加入有效 `allowOut`，例如 `my-pi-flow-bucket.oss-cn-hangzhou.aliyuncs.com`；只放行该 Bucket 域名，不放开整个 OSS 域或公网。保留用户额外配置的 allow/deny 规则；显式域名 deny 命中存储目标而没有显式 allow 时配置报错，不静默覆盖。默认 `network={}` 因此仍可访问必要的 OSS。自定义 OSS Endpoint 只接受标准 HTTPS 端口，其他端口不在域名过滤保障内。该规则符合文档，但当前没有真实云账号验证证据。
这些是部署级配置，不会自动把 Agent 策略转换成逐任务规则。

## 持久化和 Skill

每个工作区仅挂载 `<workspacePrefix>/ws-<workspaceId>` 到 `/workspace`。
存储标识包含 Bucket、Endpoint 和前缀的摘要；传入 Cube Volume ID 或另一套 OSS 配置的标识会被拒绝。
释放实例、超时回收、Skill 选择变化、文件 API 临时实例均复用这个前缀。
实例的 connect 延长可用时间；单次命令上限 130 秒，实例超时最小为 180 秒。

每次实际选择的 Skill 会聚合为独立、不可变的 OSS 集合，并只读挂载一次到 `/skills`。
工作区占 1 个挂载点，非空 Skill 集合占 1 个；20 个 Skill 也只占 2 个挂载点。
不再受“最多 4 个 Skill”的逐目录挂载限制。当前集合预算为最多 64 个版本、4096 个文件、
总计 64 MiB、单文件 8 MiB、准备时间 90 秒；超限明确拒绝，不截断选择或退回共享整库挂载。
集合沿用原有 `/skills/.../SKILL.md` 及辅助文件路径，模板不得额外预挂载 OSS。

手工只读 Skill 使用同一 Bucket 中单独、不可变的版本目录，必须先发布 `SKILL.md` 和辅助文件：

```dotenv
ALIYUN_SKILLS_JSON={"review@v1":{"bundle":"default","path":"/skills/review/v1/SKILL.md","bucketPath":"/pi-flow/skills/review/v1"}}
```

该 ID、bundle、path 必须与平台 Skill 注册记录一致，SKILL.md 内容须匹配其 digest。
只挂载本次选择的版本，读权限、目录身份和 digest 在创建及工具执行前检查。
工作区和 Skill 的 OSS 前缀不得重叠；手工 Skill 源之间也不得相同或相互包含，避免只选 A 就能读取未授权 B。服务端只挂载 `/skills`（7 字符）；内部 Skill 路径不再作为独立挂载点。bucketPath 继续按 128 字符上限校验，集合命名空间与工作区、上传区和所有手工源必须分离。
缺失挂载、可写 Skill 挂载或摘要不匹配均拒绝执行，并尝试删除创建失败的实例；
删除未确认时保留容量占用，供现有生命周期清理逻辑处理。

控制台 ZIP 上传支持自动发布到 OSS：API 完整校验 ZIP 后，将文件写入
`<skillUploadPrefix>/<随机包身份>/`，全部写入成功才登记不可变 Skill。
上传记录保留完整 64 位十六进制 `ossUpload.key`、存储标识和归档摘要，OSS 源路径仍由完整包身份推导；沙箱挂载目录改用相同 256 位身份的 base64url 编码，`/skills/uploaded/<43字符>` 共 60 字符，不截断身份或降低隔离强度。`skillUploadPrefix` 加完整包身份必须不超过 128 字符。Worker 从登记记录解析
只读挂载，不需要逐个修改 `ALIYUN_SKILLS_JSON`，也不需要重启。
手动发布的 Skill 仍通过 `ALIYUN_SKILLS_JSON` 映射。

### 手工源的完整性边界

手工登记的 Skill 当前仅由平台核对 `SKILL.md` 摘要；辅助文件和执行位没有平台登记的完整身份。
即使存在来自其他导入流程的 `versionDigest`，也不能默认按 ZIP 上传的 inventory 格式解释。
如果外部修改 `scripts/run.sh` 而不改清单，同一逻辑版本在新工作区可能得到不同集合；
已有工作区的已发布集合仍保留原副本，缓存不会自动发现这种外部辅助文件修改。

因此手工源必须由外部发布流程保证整个版本目录不可变：完整校验清单、脚本、资源和执行位，
发布到新的独立版本前缀，登记新版本并更新 Agent，不覆盖旧目录；用 IAM 将普通运行身份限制为只读，
保留发布清单和对象版本以便审计。仅启用 OSS 版本控制并不等于本实现已按 versionId 固定读取。
如果需要平台在集合构建时验证全部辅助内容，应使用控制台 ZIP 发布流程，当前该流程才有完整 inventory 校验。

API 需要配置独立的 OSS 发布凭证（不使用 Sandbox API Key 或沙箱挂载角色代替）：

```dotenv
ALIYUN_OSS_SKILL_UPLOAD_PREFIX=/pi-flow/skill-uploads
ALIYUN_OSS_REGION=oss-cn-hangzhou
ALIYUN_OSS_ACCESS_KEY_ID=<发布身份的 AccessKey ID>
ALIYUN_OSS_ACCESS_KEY_SECRET=<发布身份的 AccessKey Secret>
# STS 临时凭证额外配置；过期后需由部署系统轮换并重启 API：
# ALIYUN_OSS_SECURITY_TOKEN=<SecurityToken>
```

只在 API 部署注入发布凭证；Worker 使用相同 Bucket、Endpoint、上传和集合前缀，以及下述内部接口配置。Worker 启动不会创建 OSS 发布客户端，即使误注入发布变量也不使用。
API 未配置发布凭证时，ZIP 上传禁用，带 Skill 的新实例无法准备集合；无 Skill 工作区仍可使用。Worker 自身无需 OSS 凭证，但需连接已配置发布器的 API。只配置部分发布凭证则 API 启动报错。
API 发布身份需对上传前缀有 PutObject/DeleteObject 权限，对上传区及手工 Skill 源有 GetObject 和带前缀约束的 ListObjects 权限，对集合区有 GetObject/ListObjects/PutObject/DeleteObject 权限。沙箱挂载角色对集合区仅授予 GetObject 和必要的列举权限，对工作区按需授予读写权限，不应拥有集合区或 Skill 源的写权限。
本实现使用 OSS Node.js SDK V4 签名，支持静态 AccessKey 和 STS 临时凭证，
不自动获取或续期 STS。凭证只留在 API 进程，不进入数据库、前端或 Sandbox metadata。

上传前缀不得与工作区或手动 Skill 源重叠。每次上传使用独立的随机命名空间，
写入禁止覆盖；即使多个 API 同时上传同一个版本 ID，注册失败的一方也只清理自己的对象。
ZIP 路径、符号链接、大小、CRC、UTF-8 等限制与 Cube 上传共用。
SDK 单请求超时 20 秒，发布预算 120 秒；失败尝试删除本次已发起写入的确切对象。
只在确定元数据未提交时清理，提交结果不明则保留包，避免删掉已被引用的数据。
清理未确认返回 `SKILL_OSS_CLEANUP_UNCONFIRMED` 并记录不透明包身份，需管理员核对
登记记录后处理孤立包；存储版本控制可能保留历史版本，按 Bucket 策略处理。
网络超时的迟到写入也可能留下未登记对象；回收前应先核对持久化登记记录。

早期 PR 产生的 `/skills/uploaded/<64字符hex>/SKILL.md` 旧 OSS 记录也可聚合；它们保留原始逻辑路径，源目录仍由完整包身份解析，不需要自动改写历史记录。新上传仍使用较短的 base64url 逻辑路径。

现有 Cube `hostUpload` 包不会自动迁移。切换后应使用新 Skill 版本 ID 在控制台重新上传，
将使用该 Skill 的 Agent 更新为新版本。脚本执行位以 OSS 文件模式元数据保存，实际挂载
驱动对执行位的支持仍需目标模板联调；也可显式使用 `bash`/`python3` 解释器运行脚本。

## 按选择聚合集合

```dotenv
# API 与 Worker 使用相同值；集合区不能与任何源/工作区重叠。
ALIYUN_OSS_SKILL_COLLECTION_PREFIX=/pi-flow/skill-collections
# API 与所有 Worker 共享的独立机器凭证，至少 32 字符，不进入前端。
ALIYUN_SKILL_COLLECTION_TOKEN=<随机机器凭证>
# Worker 使用的 API origin；远程必须 HTTPS，仅 loopback 允许 HTTP。
ALIYUN_SKILL_COLLECTION_API_URL=https://pi-flow-internal.example.com
```

API 的内联 Worker 可直接调用本地集合发布器；独立 Worker 通过
`POST /internal/skill-collections/resolve` 请求准备集合，路径需要在反向代理中转发。
该接口仅接受独立机器凭证，不接受普通管理员 JWT；普通业务路由也不接受机器凭证。
请求仅携带工作区、当前租约 operation、选中版本身份和期望 scope，不能指定源或目标目录。
API 从当前租户 Store/注册表读取真实 Skill，验证工作区 volume/bundle/租约仍有效、
所选版本仍启用、内容身份及 scope 与 Worker 一致；发布完成后再检查一次租约和授权。
未配置发布器/内部接口时，带 Skill 的新沙箱返回 `SKILL_COLLECTION_PUBLISHER_REQUIRED`；
不带 Skill 的工作区和文件 API 不需要集合服务。

缓存键包含工作区卷身份和完整的选择 scope，后者包含 bundle、版本/摘要、源映射、
存储/模板/网络配置和聚合协议版本。排序不同的相同选择可复用；工作区不同、选择增减、
版本或源改变都会得到独立集合，不会通过取并集把未选中的 Skill 暴露给任务。

API 逐个读取已选源的对象（不列举整个 Bucket），校验路径、文件数/大小、SKILL.md 摘要，
对自动上传版本还验证包含辅助文件及执行位的版本摘要，然后写入随机私有构建目录。
保留二进制文件和已有执行位元数据。所有文件成功后才用禁止覆盖的写入发布 ready 指针。
并发构建只能有一个 ready 指针获胜，失败方只删除自身的私有对象；ready 写入结果不确定时
保留可能被引用的构建。Worker 只接收选择 ID 和不透明构建 ID，推导集合路径后挂载 `/skills`，
工具前检查的是精确的 `/skills` 只读挂载及各 Skill 的原始清单路径/摘要。

单次 OSS 请求最长 20 秒；发布预算 90 秒，私有失败对象尽力清理，清理未确认时输出安全遥测。
Worker 的集合请求与沙箱创建分阶段等待，等待期间继续保持租约；集合准备失败不会派发
Sandbox 创建，不占用 unknown 实例容量。API 每进程最多同时准备两个集合，忙时返回 429。

**已经发布的集合不会自动删除或覆盖。** 释放实例、更新 Agent、源 ZIP 清理都不会删除现有集合。
目前没有自动引用计数 GC：运维回收前必须确认所有活跃实例、工作区及保留任务/Agent 版本均不再引用，
不能对整个集合区设置盲目的短期过期规则。失败构建的迟到写入仍可能成为孤立对象，按 ready 指针和
平台引用核对后清理。此策略优先保证正在运行的任务不被误删，并非无限存储保留方案。
事件计数、只读库存软告警和人工回收步骤见 [集合存储运维](skill-collection-operations.md)。
平台级累计硬配额和自动 GC 仍未实现。

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
# 验证 ZIP 自动发布及真实只读挂载（需 API 发布凭证和一个测试 ZIP）：
npm run smoke:aliyun:skill -- /path/to/skill.zip
# 可选只读库存盘点（不会删除对象）：
npm run --silent inspect:aliyun:collections
```

工作区冒烟脚本创建三个实例（最多同时两个），检查写入、编辑、删除的跨实例可见性，主动 SIGKILL 写进程在 rename 前后的目标文件状态，再释放全部实例、重建验证文件。使用唯一工作区前缀，不操作已有数据。该测试不模拟节点断电，也不证明 OSS 具备 POSIX 原子性或断电持久化保证。
SIGKILL 探针从共享逐行代码生成；正常测试会对两个分支执行 Python `compile()`、通过与云端相同的 bash 命令实际执行，
要求操作系统报告 SIGKILL，并检查重命名前后的文件状态。云端断言同时要求 -9/137 信号退出、阶段标记和未超时，
不能把 Python 语法错误或其他非零退出当作成功中断。这些本地测试仍不验证 OSS。
异常时仍尝试清理实例；失败写入的测试文件和空前缀可能需要人工清理。
仓库测试使用 SDK mock 验证协议、只读挂载、隔离、错误映射、失败清理和空闲生命周期，
不代表已经通过真实阿里云账号或 Cube 集群联调。
Skill 冒烟脚本把测试 ZIP 发布到独立随机目录，读取实际挂载后的 SKILL.md、验证摘要并检查写权限被拒绝，
最后释放实例并删除原始测试上传包；独立集合缓存保留供人工核对，不向平台登记；HTTP 登记、并发与提交不确定性由仓库测试覆盖。

## PR #62 Review 验收记录

代码侧已处理：OSS 存储域名放行与冲突检查、按选择聚合为一个只读挂载、手工源相互重叠、短路径及历史路径兼容、创建/删除不确定时保留冒烟 Skill 包。
实例创建返回 `SandboxCreationError(cleanupConfirmed=false)` 或创建响应丢失时，Skill 冒烟不删除 OSS 包，输出实例 ID（未知时标记 unknown）和不透明包身份供人工核对；显式确认清理成功后才删除包。

真实云验收仍待完成，不能用参数 mock 或 CI 通过代替。目标账号需记录地域、模板版本、运行时、OSS Endpoint、挂载驱动及有效网络策略，然后执行两个冒烟脚本并留存结果。应检查默认拒绝出网下 OSS 读写、短路径 Skill 读取与只读拒写、跨实例可见性、释放重建、SIGKILL 前后状态，并在业务要求时另测节点/网络异常。当前环境未配置阿里云凭证，此文不宣称这些项目已通过。

第二轮 Review：核对 `7e457a4` 实际文件未发现引文中的顶层多余缩进，但原先“只要非零退出”的中断判定不充分。
已改为共享探针、自动语法编译、真实本地 SIGKILL 和严格阶段/信号断言。手工源辅助文件的完整身份仍由外部发布保证，
全局硬配额与自动 GC 仍是未实现项；本地测试、事件计数及只读盘点不能关闭真实云验收门槛。
