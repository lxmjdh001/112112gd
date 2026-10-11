import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const env = JSON.parse(await readFile(".runtime/e2e.json", "utf8"));
const browser = await chromium.launch({ headless: true });
const root = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const member = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
for (const p of [root, member]) {
  p.setDefaultTimeout(15000);
  p.on("pageerror", (e) => errors.push(e.message));
}
const base = "http://127.0.0.1:5779/";
async function goto(page, route, title) {
  await page.goto(base + "#/" + route);
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
}
async function tab(page, name) {
  await page.getByRole("tab", { name, exact: true }).click();
}
async function operate(root, kind, rowText, button, title, reference) {
  await goto(root, "account-center", "账户中心");
  await tab(root, "运营管理");
  await tab(root, kind);
  const row = root.locator(".el-table__body-wrapper tr").filter({ hasText: rowText });
  await row.getByRole("button", { name: button, exact: true }).click();
  const dialog = root.getByRole("dialog", { name: title, exact: true });
  if (reference) await dialog.getByLabel("审核流水号", { exact: true }).fill(reference);
  await dialog.getByRole("button", { name: "确认提交审核结果", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}
try {
  await root.goto(base + "#/auth/login");
  await root.locator("#username").fill(env.BOOTSTRAP_USERNAME);
  await root.locator("#password").fill(env.BOOTSTRAP_PASSWORD);
  await root.getByRole("button", { name: "登录", exact: true }).click();
  await root.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await goto(root, "account-center", "账户中心");
  assert.equal(
    await root.getByRole("button", { name: "申请充值", exact: true }).isDisabled(),
    true,
  );
  await tab(root, "个人资料");
  await root.getByLabel("显示名称", { exact: true }).fill("验收运营");
  await root.getByLabel("团队名称", { exact: true }).fill("验收运营团队");
  await root.getByLabel("联系方式", { exact: true }).fill("example@example.test");
  await root.getByRole("button", { name: "保存资料", exact: true }).click();
  await root.getByText("个人资料已保存", { exact: true }).waitFor();
  await root.reload({ waitUntil: "networkidle" });
  await tab(root, "个人资料");
  assert.equal(await root.getByLabel("显示名称", { exact: true }).inputValue(), "验收运营");
  await tab(root, "运营管理");
  await tab(root, "结算规则");
  await root.getByRole("spinbutton", { name: "推广佣金比例", exact: true }).fill("10");
  await root.getByLabel("充值收款说明", { exact: true }).fill("验收专用模拟收款，不接受实际资金。");
  await root.getByLabel("提现渠道名称", { exact: true }).fill("验收模拟渠道");
  for (const name of ["开放充值", "开放提现"])
    await root
      .getByRole("switch", { name, exact: true })
      .locator("xpath=ancestor::div[contains(@class,'el-switch')]")
      .click();
  await root.getByRole("button", { name: "保存结算规则", exact: true }).click();
  await root.getByText("结算规则已保存", { exact: true }).waitFor();
  await goto(root, "promotion", "推广中心");
  const link = await root.getByLabel("推广链接", { exact: true }).inputValue();
  assert.match(link, /#\/auth\/register\?ref=R-/);
  await member.goto(link);
  await member.locator("#register-team").fill("验收推广客户");
  await member.locator("#register-username").fill("commerce-member");
  await member.locator("#register-password").fill("commerce-test-password-123");
  await member.locator("#register-confirm").fill("commerce-test-password-123");
  assert.match(await member.locator("#register-referral").inputValue(), /^R-/);
  await member.getByRole("button", { name: "创建账户并登录", exact: true }).click();
  await member.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await goto(member, "account-center", "账户中心");
  await tab(member, "个人资料");
  await member.getByLabel("团队名称", { exact: true }).waitFor();
  assert.equal(await member.getByRole("tab", { name: "运营管理", exact: true }).count(), 0);
  await member.getByRole("button", { name: "申请充值", exact: true }).click();
  const recharge = member.getByRole("dialog", { name: "申请充值", exact: true });
  await recharge.getByLabel("充值金额", { exact: true }).fill("100.00");
  await recharge.getByLabel("付款流水号", { exact: true }).fill("commerce-payment-100");
  await recharge.getByRole("button", { name: "提交充值申请", exact: true }).click();
  await recharge.waitFor({ state: "hidden" });
  await member
    .locator(".el-table__body-wrapper tr")
    .filter({ hasText: "commerce-payment-100" })
    .getByText("待审核", { exact: true })
    .waitFor();
  await operate(
    root,
    "充值审核",
    "commerce-payment-100",
    "确认到账",
    "确认充值到账",
    "commerce-receipt-100",
  );
  await member.reload({ waitUntil: "networkidle" });
  await member.locator(".stats .stat").first().getByText("200", { exact: true }).waitFor();
  await tab(member, "点数流水");
  await member.locator(".el-table__body-wrapper tr").filter({ hasText: "充值入账" }).waitFor();
  await tab(member, "个人资料");
  await member.getByLabel("当前密码", { exact: true }).fill("commerce-test-password-123");
  await member.getByLabel("新密码", { exact: true }).fill("commerce-new-password-123");
  await member.getByLabel("确认新密码", { exact: true }).fill("commerce-new-password-123");
  await member.getByRole("button", { name: "更新密码", exact: true }).click();
  await member.getByText("密码已更新，其他网页会话已退出", { exact: true }).waitFor();
  await goto(root, "promotion", "推广中心");
  await root.locator(".stats .stat").nth(1).getByText("10.00", { exact: true }).waitFor();
  await root.locator(".el-table__body-wrapper tr").filter({ hasText: "验收推广客户" }).waitFor();
  await root.getByRole("button", { name: "佣金转余额", exact: true }).click();
  const transfer = root.getByRole("dialog", { name: "佣金转余额", exact: true });
  await transfer.getByLabel("佣金操作金额", { exact: true }).fill("3.00");
  await transfer.getByRole("button", { name: "确认转入余额", exact: true }).click();
  await transfer.waitFor({ state: "hidden" });
  await root.locator(".stats .stat").nth(1).getByText("7.00", { exact: true }).waitFor();
  await root.getByRole("button", { name: "申请提现", exact: true }).click();
  const withdrawal = root.getByRole("dialog", { name: "申请提现", exact: true });
  await withdrawal.getByLabel("佣金操作金额", { exact: true }).fill("4.00");
  await withdrawal
    .getByLabel("提现收款信息", { exact: true })
    .fill("test-payout-destination-123456");
  await withdrawal.getByRole("button", { name: "提交提现申请", exact: true }).click();
  await withdrawal.waitFor({ state: "hidden" });
  await root.locator(".stats .stat").nth(2).getByText("4.00", { exact: true }).waitFor();
  await operate(root, "提现审核", "验收运营团队", "通过审核", "通过提现审核");
  await operate(root, "提现审核", "验收运营团队", "登记打款", "确认已打款", "commerce-payout-4");
  await goto(root, "promotion", "推广中心");
  await root.locator(".stats .stat").nth(2).getByText("0.00", { exact: true }).waitFor();
  await tab(root, "提现记录");
  await root
    .locator(".el-table__body-wrapper tr")
    .filter({ hasText: "commerce-payout-4" })
    .getByText("已支付", { exact: true })
    .waitFor();
  await root.waitForTimeout(400);
  await root.screenshot({ path: ".runtime/promotion-center.png", fullPage: true });
  await goto(root, "account-center", "账户中心");
  await root.locator(".stats .stat").first().getByText("3", { exact: true }).waitFor();
  await tab(root, "点数流水");
  await root.locator(".el-table__body-wrapper tr").filter({ hasText: "佣金转入" }).waitFor();
  await root.waitForTimeout(400);
  await root.screenshot({ path: ".runtime/account-center.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: [
        "profile persistence",
        "operator-only configuration",
        "referral registration and tenant separation",
        "manual recharge approval",
        "wallet and commission credit",
        "password form",
        "commission transfer",
        "withdrawal hold, approval and paid ledger",
        "real paginated records",
      ],
      browserErrors: errors,
    }),
  );
} catch (e) {
  await root
    .screenshot({ path: ".runtime/commerce-root-failure.png", fullPage: true })
    .catch(() => {});
  await member
    .screenshot({ path: ".runtime/commerce-member-failure.png", fullPage: true })
    .catch(() => {});
  throw e;
} finally {
  await browser.close();
}
