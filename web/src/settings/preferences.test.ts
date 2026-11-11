import { it, expect, vi } from "vitest";
import {
  loadPreferences,
  storePreferences,
  shouldSend,
  defaults,
} from "./preferences";
it("persists preferences separately per identity and recovers corrupt data", () => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) || null,
    setItem: (k: string, v: string) => data.set(k, v),
  });
  try {
    storePreferences("alice", {
      theme: "dark",
      sendShortcut: "ctrlEnter",
      defaultAgent: "assistant",
    });
    expect(loadPreferences("alice").theme).toBe("dark");
    expect(loadPreferences("bob")).toEqual(defaults);
    data.set("pi-flow-preferences:alice", "invalid");
    expect(loadPreferences("alice")).toEqual(defaults);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("honors shortcuts, multiline and IME composition", () => {
  expect(shouldSend("Enter", false, false, false, false, "enter")).toBe(true);
  expect(shouldSend("Enter", false, false, false, false, "ctrlEnter")).toBe(
    false,
  );
  expect(shouldSend("Enter", false, true, false, false, "ctrlEnter")).toBe(
    true,
  );
  expect(shouldSend("Enter", false, false, true, false, "ctrlEnter")).toBe(
    true,
  );
  for (const shortcut of ["enter", "ctrlEnter"] as const) {
    expect(shouldSend("Enter", false, true, false, true, shortcut)).toBe(false);
    expect(shouldSend("Enter", true, true, false, false, shortcut)).toBe(false);
  }
});
