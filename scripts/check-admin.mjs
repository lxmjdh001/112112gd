import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const env = JSON.parse(await readFile(".runtime/e2e.json", "utf8"));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
// Verify the exact value sent to the clipboard without overwriting the user's clipboard.
await page.addInitScript(() => {
  window.__copiedCode = "";
  window.__copyDenied = false;
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (value) => {
        if (window.__copyDenied) throw new DOMException("Denied", "NotAllowedError");
        window.__copiedCode = value;
      },
    },
    configurable: true,
  });
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(15000);
try {
  await page.goto("http://127.0.0.1:5779/#/auth/login", { waitUntil: "networkidle" });
  await page.locator("#username").fill(env.BOOTSTRAP_USERNAME);
  await page.locator("#password").fill(env.BOOTSTRAP_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "工作台" }).waitFor();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: ".runtime/admin-dashboard.png", fullPage: true });
  await page.goto("http://127.0.0.1:5779/#/login-codes");
  await page.waitForTimeout(1000);
  // Create and select a group inside the login-code form.
  await page.getByRole("button", { name: "＋ 创建登录码" }).click();
  await page.getByRole("button", { name: "新建分组", exact: true }).click();
  await page.getByPlaceholder("分组名称，例如：投放一组").fill("投放一组");
  await page
    .getByRole("dialog", { name: "管理分组" })
    .getByRole("button", { name: "新建分组", exact: true })
    .click();
  await page.getByRole("dialog", { name: "管理分组" }).waitFor({ state: "hidden" });
  assert.match(await page.getByRole("dialog", { name: "创建长期登录码" }).innerText(), /投放一组/);
  await page.getByPlaceholder("例如：客服小林、投手小王").fill("验收 · 使用者01");
  const createDialog = page.getByRole("dialog", { name: "创建长期登录码" });
  assert.doesNotMatch(await createDialog.innerText(), /最多设备数|平台账号额度/);
  assert.equal(await createDialog.getByRole("spinbutton").count(), 0);
  assert.equal(
    await createDialog.getByRole("button", { name: "生成登录码", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await createDialog.getByRole("button", { name: "LINE", exact: true }).isDisabled(),
    false,
  );
  assert.equal(
    await createDialog.getByRole("button", { name: "Facebook", exact: true }).count(),
    0,
  );
  await createDialog.getByText("WhatsApp", { exact: true }).click();
  await page.screenshot({ path: ".runtime/login-code-platforms.png", fullPage: true });

  const creation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/login-codes") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "生成登录码" }).click();
  const createdID = (await (await creation).json()).data.id;
  await page.getByText("登录码已生成", { exact: true }).waitFor();
  const code = await page.locator(".secret").innerText();
  if (!code.startsWith("GD7-")) throw Error("No login code");
  await page.getByRole("button", { name: "已保存，关闭" }).click();
  await page.getByText("验收 · 使用者01", { exact: true }).first().waitFor();
  const firstRow = page
    .locator(".business > .panel .el-table__body-wrapper tr")
    .filter({ hasText: "验收 · 使用者01" });
  assert.match(await firstRow.innerText(), /投放一组/);
  assert.match(await firstRow.innerText(), /WhatsApp/);
  async function copyFromRow() {
    await page.evaluate(() => {
      window.__copiedCode = "";
    });
    await firstRow.getByRole("button", { name: "复制", exact: true }).click();
    await page.waitForFunction((expected) => window.__copiedCode === expected, code);
  }
  await copyFromRow();
  await page.reload({ waitUntil: "networkidle" });
  await firstRow.waitFor();
  await copyFromRow();
  assert(
    !(await firstRow.innerText()).includes(code),
    "The table must keep the complete code masked",
  );
  // If the browser blocks clipboard access, expose a selectable value with a retry button.
  await page.evaluate(() => {
    window.__copyDenied = true;
  });
  await firstRow.getByRole("button", { name: "复制", exact: true }).click();
  const copyDialog = page.getByRole("dialog", { name: "复制登录码", exact: true });
  await copyDialog.waitFor();
  assert.equal(await copyDialog.locator(".secret").innerText(), code);
  await page.evaluate(() => {
    window.__copyDenied = false;
  });
  await copyDialog.getByRole("button", { name: "复制登录码", exact: true }).click();
  await copyDialog.getByRole("button", { name: "已保存，关闭", exact: true }).click();
  // Simulate a pre-upgrade hash-only row in this test's isolated schema.
  assert.match(env.schema, /^gd007_e2e_[0-9a-f]+$/);
  assert.match(createdID, /^[0-9a-f-]{36}$/);
  const fixtureDatabase = new URL(env.DATABASE_URL);
  fixtureDatabase.searchParams.delete("search_path");
  const legacy = spawnSync(
    (process.env.GONGDAN_PG_BIN || "/opt/homebrew/opt/postgresql@17/bin") + "/psql",
    [
      fixtureDatabase.toString(),
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `UPDATE ${env.schema}.login_codes SET code_cipher='' WHERE id='${createdID}'`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(legacy.status, 0, "Legacy fixture setup failed");
  await page.reload({ waitUntil: "networkidle" });
  await firstRow.getByRole("button", { name: "复制", exact: true }).click();
  const recovery = page.getByRole("dialog", { name: "补存原登录码", exact: true });
  await recovery.getByPlaceholder("粘贴完整的 GD7-… 登录码").fill("GD7-incorrect-original-code");
  await recovery.getByRole("button", { name: "保存并复制", exact: true }).click();
  await page.getByText("原登录码与当前记录不匹配，请检查后重试", { exact: true }).waitFor();
  await recovery.getByPlaceholder("粘贴完整的 GD7-… 登录码").fill(code);
  await recovery.getByRole("button", { name: "保存并复制", exact: true }).click();
  await recovery.waitFor({ state: "hidden" });
  await page.waitForFunction((expected) => window.__copiedCode === expected, code);
  await page.reload({ waitUntil: "networkidle" });
  await firstRow.waitFor();
  await copyFromRow();
  await page.screenshot({ path: ".runtime/login-code-copy.png", fullPage: true });
  await firstRow.getByRole("button", { name: "编辑", exact: true }).click();
  const editDialog = page.getByRole("dialog", { name: "编辑登录码", exact: true });
  await editDialog.getByText("WhatsApp", { exact: true }).click();
  await editDialog.getByRole("button", { name: "保存更改", exact: true }).click();
  await editDialog.waitFor({ state: "hidden" });
  await firstRow.getByText("未分配平台", { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await firstRow.getByText("未分配平台", { exact: true }).waitFor();
  await firstRow.getByRole("button", { name: "编辑", exact: true }).click();
  await editDialog.getByText("WhatsApp", { exact: true }).click();
  await editDialog.getByRole("button", { name: "保存更改", exact: true }).click();
  await editDialog.waitFor({ state: "hidden" });
  await firstRow.getByText("WhatsApp", { exact: true }).waitFor();

  // A second code without a group supports filtering and a real batch move.
  await page.getByRole("button", { name: "＋ 创建登录码" }).click();
  await page.getByPlaceholder("例如：客服小林、投手小王").fill("验收 · 使用者02");
  await page
    .getByRole("dialog", { name: "创建长期登录码" })
    .getByText("WhatsApp", { exact: true })
    .click();
  await page.getByRole("button", { name: "生成登录码" }).click();
  await page.getByText("登录码已生成", { exact: true }).waitFor();
  await page.getByRole("button", { name: "已保存，关闭" }).click();
  await page.getByText("验收 · 使用者02", { exact: true }).first().waitFor();
  async function filterGroup(label) {
    await page
      .getByRole("combobox", { name: "筛选分组", exact: true })
      .locator("xpath=ancestor::div[contains(@class, 'el-select__wrapper')]")
      .click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).waitFor({ state: "hidden" });
  }
  await filterGroup("投放一组（1）");
  assert.equal(await page.locator(".business > .panel .el-table__body-wrapper tr").count(), 1);
  assert.match(
    await page.locator(".business > .panel .el-table__body-wrapper").innerText(),
    /使用者01/,
  );
  await filterGroup("未分组（1）");
  assert.match(
    await page.locator(".business > .panel .el-table__body-wrapper").innerText(),
    /使用者02/,
  );
  await filterGroup("全部分组（2）");
  await page.locator(".business > .panel .el-table__header-wrapper .el-checkbox").click();
  await page.getByRole("button", { name: /移动分组\s*（2）/ }).click();
  await page
    .getByRole("combobox", { name: "目标分组", exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'el-select__wrapper')]")
    .click();
  await page.getByRole("option", { name: "投放一组", exact: true }).click();
  await page.getByRole("button", { name: "确认移动", exact: true }).click();
  await page.getByRole("dialog", { name: "移动分组" }).waitFor({ state: "hidden" });
  await filterGroup("投放一组（2）");
  assert.equal(await page.locator(".business > .panel .el-table__body-wrapper tr").count(), 2);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("验收 · 使用者01", { exact: true }).first().waitFor();
  assert.equal(
    await page
      .locator(".business > .panel .el-table__body-wrapper tr")
      .filter({ hasText: "投放一组" })
      .count(),
    2,
  );
  await page.getByRole("button", { name: "管理分组", exact: true }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page.locator(".el-message-box__input input").fill("投放二组");
  await page.locator(".el-message-box").getByRole("button", { name: "保存", exact: true }).click();
  await page
    .getByRole("dialog", { name: "管理分组" })
    .getByText("投放二组", { exact: true })
    .waitFor();
  await page
    .getByRole("dialog", { name: "管理分组" })
    .getByRole("button", { name: "完成", exact: true })
    .click();
  await filterGroup("投放二组（2）");
  await page.screenshot({ path: ".runtime/admin-codes.png", fullPage: true });
  await page.getByRole("button", { name: "管理分组", exact: true }).click();
  await page
    .getByRole("dialog", { name: "管理分组" })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "删除分组", exact: true })
    .click();
  await page.getByText("暂无分组，创建后可分类管理登录码", { exact: true }).waitFor();
  await page
    .getByRole("dialog", { name: "管理分组" })
    .getByRole("button", { name: "完成", exact: true })
    .click();
  await filterGroup("未分组（2）");
  assert.equal(await page.locator(".business > .panel .el-table__body-wrapper tr").count(), 2);
  assert.equal(
    await page
      .locator(".business > .panel .el-table__body-wrapper tr")
      .filter({ hasText: "未分组" })
      .count(),
    2,
  );
  // Deleting a selection is explicit, cancellable, durable, and distinct from group deletion.
  const codeRows = page.locator(".business > .panel .el-table__body-wrapper tr");
  const batchDelete = page.getByRole("button", { name: /批量删除/ });
  assert.equal(await batchDelete.isDisabled(), true);
  assert.doesNotMatch(
    await page.locator(".business > .panel").innerText(),
    /设备 \/ 额度|账号 \/ 额度/,
  );
  await page.locator(".business > .panel .el-table__header-wrapper .el-checkbox").click();
  await page.getByRole("button", { name: /批量删除\s*（2）/ }).click();
  const confirmDelete = page.locator(".el-message-box");
  assert.match(await confirmDelete.innerText(), /平台账号和客户历史记录保留/);
  await confirmDelete.getByRole("button", { name: "取消", exact: true }).click();
  await confirmDelete.waitFor({ state: "hidden" });
  assert.equal(await codeRows.count(), 2);
  await page.getByRole("button", { name: /批量删除\s*（2）/ }).click();
  await page.screenshot({ path: ".runtime/login-code-batch-delete.png", fullPage: true });
  await confirmDelete.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByText("还没有登录码，点击“创建登录码”开始", { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("还没有登录码，点击“创建登录码”开始", { exact: true }).waitFor();
  assert.equal(await batchDelete.isDisabled(), true);
  await page.getByRole("button", { name: "＋ 创建登录码" }).click();
  await page.getByPlaceholder("例如：客服小林、投手小王").fill("单条删除验收");
  await createDialog.getByText("WhatsApp", { exact: true }).click();
  await createDialog.getByRole("button", { name: "生成登录码", exact: true }).click();
  await page.getByRole("button", { name: "已保存，关闭" }).click();
  await codeRows
    .filter({ hasText: "单条删除验收" })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await confirmDelete.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByText("还没有登录码，点击“创建登录码”开始", { exact: true }).waitFor();
  await page.goto("http://127.0.0.1:5779/#/proxies");
  await page.getByRole("button", { name: "＋ 添加 / 批量导入" }).click();
  await page.getByPlaceholder(/127.0.0.1:1080/).fill("host:0\n127.0.0.1:1080");
  await page.getByRole("button", { name: "识别并保存代理" }).click();
  await page.getByText(/第 1 行/).waitFor();
  const proxyDialog = page.getByRole("dialog", { name: "批量添加代理" });
  await proxyDialog.getByRole("button", { name: "新建分组", exact: true }).click();
  const proxyGroups = page.getByRole("dialog", { name: "管理代理分组" });
  await proxyGroups.getByPlaceholder("分组名称，例如：美国代理").fill("美国测试代理");
  await proxyGroups.getByRole("button", { name: "新建分组", exact: true }).click();
  await proxyGroups.waitFor({ state: "hidden" });
  assert.match(await proxyDialog.innerText(), /美国测试代理/);
  await proxyDialog.getByRole("spinbutton", { name: "每平台最多登录", exact: true }).fill("3");
  await proxyDialog
    .getByRole("switch", { name: "启用代理", exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'el-switch')]")
    .click();
  await page.getByPlaceholder(/127.0.0.1:1080/).fill("alpha.test:1080\nbeta.test:1080");
  await page.screenshot({ path: ".runtime/admin-proxy-import.png", fullPage: true });
  await proxyDialog.getByRole("button", { name: "识别并保存代理" }).click();
  await proxyDialog.waitFor({ state: "hidden" });
  const proxyRows = page.locator(".business > .panel .el-table__body-wrapper tr");
  await proxyRows.filter({ hasText: "alpha.test" }).waitFor();
  assert.equal(await proxyRows.count(), 2);
  assert.equal(await proxyRows.filter({ hasText: "已禁用" }).count(), 2);
  async function selectProxyFilter(name, label) {
    await page
      .getByRole("combobox", { name, exact: true })
      .locator("xpath=ancestor::div[contains(@class, 'el-select__wrapper')]")
      .click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).waitFor({ state: "hidden" });
  }
  await selectProxyFilter("筛选代理分组", "美国测试代理（2）");
  await selectProxyFilter("筛选代理状态", "已禁用");
  await page.locator(".business > .panel .el-table__header-wrapper .el-checkbox").click();
  await page.getByRole("button", { name: "批量启用", exact: true }).click();
  await page.getByText("没有符合条件的代理", { exact: true }).waitFor();
  await selectProxyFilter("筛选代理状态", "已启用");
  assert.equal(await proxyRows.count(), 2);
  await proxyRows
    .filter({ hasText: "alpha.test" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  const proxySettings = page.getByRole("dialog", { name: "代理设置" });
  assert.equal(
    await proxySettings.getByRole("spinbutton", { name: "调整每平台上限" }).inputValue(),
    "3",
  );
  await proxySettings.getByRole("spinbutton", { name: "调整每平台上限" }).fill("2");
  await proxySettings.getByRole("button", { name: "保存设置", exact: true }).click();
  await proxySettings.waitFor({ state: "hidden" });
  await page.reload({ waitUntil: "networkidle" });
  await proxyRows.filter({ hasText: "alpha.test" }).waitFor();
  await proxyRows
    .filter({ hasText: "alpha.test" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  assert.equal(
    await proxySettings.getByRole("spinbutton", { name: "调整每平台上限" }).inputValue(),
    "2",
  );
  await proxySettings.locator(".el-dialog__headerbtn").click();
  await proxySettings.waitFor({ state: "hidden" });
  await page.locator(".business > .panel .el-table__header-wrapper .el-checkbox").click();
  await page.getByRole("button", { name: "移动分组", exact: true }).click();
  await selectProxyFilter("目标代理分组", "未分组");
  await page
    .getByRole("dialog", { name: "移动代理分组" })
    .getByRole("button", { name: "确认移动" })
    .click();
  await page.getByRole("dialog", { name: "移动代理分组" }).waitFor({ state: "hidden" });
  await selectProxyFilter("筛选代理分组", "未分组（2）");
  assert.match(
    await page
      .getByRole("combobox", { name: "筛选代理分组", exact: true })
      .locator("xpath=ancestor::div[contains(@class, 'el-select__wrapper')]")
      .innerText(),
    /未分组/,
  );
  await page.locator(".business > .panel .el-table__header-wrapper .el-checkbox").click();
  await page.getByRole("button", { name: "批量禁用", exact: true }).click();
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "确认禁用", exact: true })
    .click();
  await selectProxyFilter("筛选代理状态", "已禁用");
  await proxyRows.filter({ hasText: "已禁用" }).first().waitFor();
  assert.equal(await proxyRows.filter({ hasText: "已禁用" }).count(), 2);
  await page.getByRole("button", { name: "管理分组", exact: true }).click();
  await proxyGroups.getByRole("button", { name: "删除", exact: true }).click();
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "删除分组", exact: true })
    .click();
  await page.getByText("暂无分组，创建后可分类管理代理", { exact: true }).waitFor();
  await proxyGroups.getByRole("button", { name: "完成", exact: true }).click();
  await proxyGroups.waitFor({ state: "hidden" });
  await page.screenshot({ path: ".runtime/admin-proxies.png", fullPage: true });
  for (const route of [
    "#/platform-accounts",
    "#/promotion",
    "#/account-center",
    "#/baseline",
    "#/leads",
    "#/customers",
    "#/login-logs",
  ]) {
    await page.goto("http://127.0.0.1:5779/" + route);
    await page.locator(".business h1").waitFor();
    if (route === "#/platform-accounts") {
      await page.getByRole("heading", { name: "账号列表", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: /创建账号|添加账号/ }).count(), 0);
      assert.match(await page.locator(".business").innerText(), /账号在客户端添加并登录/);
    }
  }
  console.log(
    JSON.stringify({
      passed: [
        "admin login",
        "dashboard",
        "create reusable code",
        "repeat code copy after reload, clipboard denial fallback and legacy recovery",
        "explicit platform selection, editing, persistence and planned platforms disabled",
        "group create, filter, batch move, rename, reload and delete",
        "login codes without device/account quotas; single and batch deletion, cancellation and persistence",
        "proxy validation, groups, limits, persistence, bulk move and enable/disable",
        "all 10 routes",
      ],
      browserErrors: errors,
    }),
  );
  assert.deepEqual(errors, [], "Unexpected browser errors");
} catch (error) {
  await page.screenshot({ path: ".runtime/admin-failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
