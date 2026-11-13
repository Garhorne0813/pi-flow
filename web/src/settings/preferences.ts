import { z } from "zod";
export const Preferences = z.object({
  theme: z.enum(["system", "light", "dark"]).default("system"),
  sendShortcut: z.enum(["enter", "ctrlEnter"]).default("enter"),
  defaultAgent: z.string().default(""),
});
export type Preferences = z.infer<typeof Preferences>;
export const defaults: Preferences = Preferences.parse({});
export function loadPreferences(userId: string): Preferences {
  try {
    return Preferences.parse(
      JSON.parse(localStorage.getItem("pi-flow-preferences:" + userId) || "{}"),
    );
  } catch {
    return { ...defaults };
  }
}
export function storePreferences(userId: string, value: Preferences) {
  localStorage.setItem(
    "pi-flow-preferences:" + userId,
    JSON.stringify(Preferences.parse(value)),
  );
}
export function applyTheme(theme: Preferences["theme"]) {
  const resolved =
    theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.dataset.theme = resolved;
  document.body.toggleAttribute("data-ds-dark-theme", resolved === "dark");
}
export function shouldSend(
  key: string,
  shift: boolean,
  ctrl: boolean,
  meta: boolean,
  composing: boolean,
  shortcut: Preferences["sendShortcut"],
) {
  return (
    key === "Enter" &&
    !composing &&
    !shift &&
    (shortcut === "enter" ? !ctrl && !meta : ctrl || meta)
  );
}
export interface Identity {
  userId: string;
  role: "admin" | "user";
  admin: boolean;
  expiresAt?: number;
}
