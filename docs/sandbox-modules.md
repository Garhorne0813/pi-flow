# Sandbox 模块边界

adapters/sandbox.ts 保留 SandboxManager 公共 API 和跨 Store/Provider 的编排。
旧导入路径继续 re-export CubeProvider、DemoSandbox 与 SandboxProvider，调用方无需迁移。

- sandbox/provider.ts：Provider 契约；不访问 Store，不承担容量或租约决策。
- sandbox/cube-provider.ts：Cube SDK、挂载和受控远程工具适配。
- sandbox/demo-provider.ts：内存 Fake；不执行本地命令，测试可确定性替换 Provider。
- sandbox/remote.ts：有界等待、取消、迟到结果回调；不自动重试远端操作。
- sandbox/lease-manager.ts：纯租约/生命周期资格判断；不发起 SDK 请求。
- adapters/sandbox-policy.ts：持久容量转换、operation fencing 和 quota。

Manager 在事务内调用纯判断，然后持久化代次并调用 Provider；返回后再次检查
锁所有权和有效期。create/createVolume 通过 remote 的 late 回调确认清理；
kill 未确认或创建无 ID 的未知结果持续占用容量。文件临时实例与 Agent 实例
分别记录操作代次；快照和 idle 生命周期沿用相同受控 managed/record 边界。
新增远端操作必须选择 local timeout、取消处理和迟到清理策略，不能直接无界 await。

此次是渐进提取，保留已验证的文件/快照编排在 Manager；未来可在该边界逐项
提取，不复制状态机、不降低 reserved/unknown 计数或不重放保证。
