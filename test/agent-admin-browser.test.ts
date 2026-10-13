import assert from "node:assert/strict";
import { chromium as browserEngine } from "playwright-core";
import { existsSync } from "node:fs";
import test from "node:test";
import { AgentConfig } from "../src/domain.js";
import { agentAdminHTML } from "../src/agent-admin-ui.js";

const chromium = [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((path): path is string => !!path && existsSync(path));

test("native browser constraint validation permits an empty System Prompt", {skip: !chromium}, async () => {
  const browser = await browserEngine.launch({executablePath:chromium,args:["--no-sandbox"]});
  try {
    const page = await browser.newPage();
    // Native validation uses the actual form markup without controller requests.
    await page.setContent(agentAdminHTML.replace(/<script[^>]*>[\s\S]*?<\/script>/,""));
    const valid = await page.evaluate(() => {
      for (const input of document.querySelectorAll<HTMLInputElement>('#form input[required]'))
        input.value = input.type === 'number' ? (input.min || '1') : 'test';
      (document.getElementById('prompt') as HTMLTextAreaElement).value = '';
      return (document.getElementById('form') as HTMLFormElement).checkValidity();
    });
    assert.equal(valid,true);
  } finally {await browser.close();}
});

test("empty System Prompt matches the API schema and the form's declared constraint", () => {
  assert.equal(AgentConfig.parse({name:"Minimal",systemPrompt:"",model:{provider:"demo",modelId:"demo"},tools:[],skillBundle:"default"}).systemPrompt,"");
  const promptTag = agentAdminHTML.match(/<textarea\b[^>]*\bid="prompt"[^>]*>/)?.[0];
  assert.ok(promptTag);
  assert.doesNotMatch(promptTag,/\brequired\b/);
});
