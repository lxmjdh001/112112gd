// Run after building the desktop: node scripts/check-customer-tags.mjs
// Exercises the real renderer with synthetic customers and an in-memory API.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const state = {
      loggedIn: true,
      connection: "online",
      label: "标签验收",
      accounts: [],
      platforms: [{ id: "whatsapp", name: "WhatsApp" }],
      activeId: "",
      statuses: {},
      apiURL: "",
      message: "",
    };
    const profiles = new Map();
    let onState;
    const fixture = (window.tagFixture = {
      tags: [
        { id: "vip", name: "VIP" },
        { id: "follow", name: "重点跟进" },
      ],
      assetsFail: true,
      tagsFail: false,
      customerFail: false,
      saveFail: false,
      holdSave: false,
      writes: [],
      releaseSave: undefined,
      update(identifier) {
        state.customer = identifier
          ? { accountId: "account", identifier, name: identifier }
          : undefined;
        onState(state);
      },
    });
    window.gongdan = {
      state: async () => state,
      onState: (fn) => {
        onState = fn;
      },
      toolsModal: async () => {},
      customerLanguage: async () => {},
      setToolsCollapsed: async (collapsed) => {
        state.toolsCollapsed = collapsed;
        onState(state);
      },
      toolsRequest: async (method, path, body) => {
        if (path === "/assets") {
          if (fixture.assetsFail) throw Error("素材暂不可用");
          return [];
        }
        if (path === "/tags") {
          if (method === "POST") {
            fixture.tags.push({ id: "new", name: body.name });
            return {};
          }
          if (fixture.tagsFail) throw Error("连接中断");
          return structuredClone(fixture.tags);
        }
        if (path === "/customer") {
          if (fixture.customerFail) throw Error("客户请求失败");
          if (!profiles.has(body.identifier))
            profiles.set(body.identifier, {
              identifier: body.identifier,
              platform: "whatsapp",
              details: {},
              language: "en",
              version: 1,
              tags: [],
            });
          return structuredClone(profiles.get(body.identifier));
        }
        if (path === "/customer/tag") {
          fixture.writes.push(structuredClone(body));
          if (fixture.holdSave)
            await new Promise((resolve) => {
              fixture.releaseSave = resolve;
            });
          if (fixture.saveFail) throw Error("保存请求失败");
          const p = profiles.get(body.identifier);
          p.tags = body.assigned
            ? [...new Set([...p.tags, body.tagId])]
            : p.tags.filter((t) => t !== body.tagId);
          return {};
        }
        throw Error("Unexpected route " + path);
      },
    };
  });
  await page.goto(pathToFileURL(resolve("apps/desktop/dist/index.html")).href);
  const trigger = page.getByRole("button", { name: "选择客户标签", exact: true });
  const menu = page.locator(".ct-tag-menu");
  const option = (name) => menu.getByRole("button", { name, exact: true });
  const open = async () => {
    if (await menu.isHidden()) await trigger.click();
  };
  const update = async (id) => {
    await page.evaluate((id) => window.tagFixture.update(id), id);
    if (id) await page.waitForFunction(() => !document.querySelector(".ct-language").disabled);
  };
  // No customer: trigger responds, catalog survives an unrelated asset failure.
  await open();
  await option("VIP").waitFor();
  assert.equal(await option("VIP").isDisabled(), true);
  assert.match(await menu.locator(".ct-tag-hint").innerText(), /尚未识别到当前客户/);
  await menu.getByRole("searchbox").fill("不存在");
  await menu.getByText("没有匹配的标签", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await menu.isHidden(), true);
  assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "visible" });
  await page.locator(".ct-customer").click();
  assert.equal(await menu.isHidden(), true);
  assert.equal(await page.evaluate(() => window.tagFixture.writes.length), 0);

  // Saving prevents duplicate requests, and late responses cannot label another customer.
  await update("15550000001");
  await open();
  await menu.getByRole("searchbox").fill("vip");
  assert.equal(await page.locator(".ct-tag-option").count(), 1);
  await page.evaluate(() => {
    window.tagFixture.holdSave = true;
  });
  await option("VIP").click();
  await page.waitForFunction(() => !!window.tagFixture.releaseSave);
  assert.equal(await option("VIP").isDisabled(), true);
  await update("15550000002");
  assert.equal(await menu.isHidden(), true);
  await page.evaluate(() => {
    window.tagFixture.holdSave = false;
    window.tagFixture.releaseSave();
  });
  await open();
  await page.waitForFunction(() => !document.querySelector(".ct-tag-option").disabled);
  assert.equal(await page.locator(".ct-tags button").count(), 0);
  assert.equal(await page.evaluate(() => window.tagFixture.writes.length), 1);
  await update("15550000001");
  await page.getByRole("button", { name: "VIP ×", exact: true }).click();
  await page.getByText("标签已移除", { exact: true }).waitFor();
  await open();
  await option("重点跟进").click();
  await page.getByRole("button", { name: "重点跟进 ×", exact: true }).waitFor();
  assert.equal(await menu.isHidden(), true);

  // Tag loading failures have a local retry; customer failures have a separate retry.
  await page.evaluate(() => {
    window.tagFixture.assetsFail = false;
    window.tagFixture.tagsFail = true;
  });
  await page.getByRole("button", { name: "刷新工具资料", exact: true }).click();
  await open();
  await option("重新加载标签").waitFor();
  await page.evaluate(() => {
    window.tagFixture.tagsFail = false;
  });
  await option("重新加载标签").click();
  await option("VIP").waitFor();
  await page.evaluate(() => {
    window.tagFixture.customerFail = true;
    window.tagFixture.update("15550000003");
  });
  await open();
  await option("重新加载客户").waitFor();
  assert.equal(await option("VIP").isDisabled(), true);
  await page.evaluate(() => {
    window.tagFixture.customerFail = false;
  });
  await option("重新加载客户").click();
  await page.waitForFunction(() => !document.querySelector(".ct-tag-option").disabled);
  await page.evaluate(() => {
    window.tagFixture.saveFail = true;
  });
  await option("VIP").click();
  await page.getByText("标签保存失败：保存请求失败", { exact: true }).waitFor();
  assert.equal(await page.locator(".ct-tags button").count(), 0);
  await page.evaluate(() => {
    window.tagFixture.saveFail = false;
  });
  await option("VIP").click();
  await page.getByRole("button", { name: "VIP ×", exact: true }).waitFor();

  // Empty catalog leads to creation, and the new tag is available immediately.
  await page.evaluate(() => {
    window.tagFixture.tags = [];
  });
  await update("15550000004");
  await page.getByRole("button", { name: "刷新工具资料", exact: true }).click();
  await open();
  await option("＋ 新建标签").click();
  const dialog = page.getByRole("dialog", { name: "新建客户标签", exact: true });
  await dialog.getByLabel("标签名称").fill("测试标签");
  await dialog.getByRole("button", { name: "创建标签", exact: true }).click();
  await option("测试标签").click();
  await page.getByRole("button", { name: "测试标签 ×", exact: true }).waitFor();
  await open();
  await menu.getByText("已添加全部标签", { exact: true }).waitFor();
  await page.getByRole("button", { name: "折叠客户工具", exact: true }).click();
  await page.getByRole("button", { name: "展开客户工具", exact: true }).click();
  assert.equal(await menu.isHidden(), true);
  assert.deepEqual(errors, []);
  console.log(
    "Customer tags: opening, search, keyboard, empty state, creation, assignment/removal, retries and customer-switch isolation passed (mocked API).",
  );
} finally {
  await browser.close();
}
