import { useState } from "react";
import { defaults, type Identity, type Preferences } from "./preferences";
export function UserSettings({
  identity,
  preferences,
  onChange,
  agents,
}: {
  identity: Identity;
  preferences: Preferences;
  onChange: (p: Preferences) => void;
  agents: { id?: string; key?: string; config: { name: string } }[];
}) {
  const [message, setMessage] = useState("");
  const update = (p: Preferences) => {
    try {
      onChange(p);
      setMessage("设置已保存");
    } catch {
      setMessage("无法保存设置，请检查浏览器存储权限。");
    }
  };
  return (
    <section className="settings settings-page">
      <h1>个人设置</h1>
      <p>自定义你的对话体验。偏好仅保存在此浏览器，按当前用户分别保存。</p>
      <section className="settings-card">
        <h2>登录身份</h2>
        <dl>
          <dt>用户 ID</dt>
          <dd>{identity.userId}</dd>
          <dt>角色</dt>
          <dd>{identity.admin ? "管理员" : "普通用户"}</dd>
          {identity.expiresAt && (
            <>
              <dt>登录有效期</dt>
              <dd>{new Date(identity.expiresAt).toLocaleString()}</dd>
            </>
          )}
        </dl>
      </section>
      <section className="settings-card">
        <h2>对话偏好</h2>
        <label>
          外观
          <select
            value={preferences.theme}
            onChange={(e) =>
              update({
                ...preferences,
                theme: e.target.value as Preferences["theme"],
              })
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label>
          发送快捷键
          <select
            value={preferences.sendShortcut}
            onChange={(e) =>
              update({
                ...preferences,
                sendShortcut: e.target.value as Preferences["sendShortcut"],
              })
            }
          >
            <option value="enter">Enter 发送</option>
            <option value="ctrlEnter">Ctrl / ⌘ + Enter 发送</option>
          </select>
        </label>
        <p>Shift+Enter 始终换行；输入法组词时不会发送。</p>
        <label>
          新对话默认 Agent
          <select
            value={preferences.defaultAgent}
            onChange={(e) =>
              update({ ...preferences, defaultAgent: e.target.value })
            }
          >
            <option value="">列表中的首个可用 Agent</option>
            {agents.map((a) => (
              <option key={a.key || a.id} value={a.key || a.id}>
                {a.config.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => update({ ...defaults })}>恢复默认设置</button>
      </section>
      <p role="status">{message}</p>
    </section>
  );
}
