import assert from "node:assert/strict";

// Runs against the native-view synthetic fixture. Never pairs a phone or sends a message.
export async function checkCustomerTools(app, page, wa, accountId) {
  const native = (script) =>
    app.evaluate(
      async ({ webContents }, { wa, script }) => webContents.fromId(wa).executeJavaScript(script),
      { wa, script },
    );
  await native(`(() => {
    const main=document.querySelector('#main');
    main.style.cssText='position:fixed;inset:0;background:#f4f7f5;z-index:99999;padding:24px';
    const header=document.createElement('header');header.innerHTML='<b title="ERIC">ERIC · 447410419512</b>';main.prepend(header);
    const footer=document.createElement('footer');footer.style.cssText='position:absolute;bottom:25px;left:24px;right:24px';
    footer.innerHTML='<div role="textbox" contenteditable="true" style="min-height:60px;background:white;border:1px solid #ddd;padding:16px"></div>';
    footer.firstChild.addEventListener('paste', e=>{document.documentElement.dataset.gd7Paste=[...e.clipboardData.items].map(x=>x.type).join(',');});
    main.append(footer);
  })()`);
  await page.waitForFunction(
    () =>
      document.querySelector(".ct-customer small")?.textContent === "447410419512" &&
      !document.querySelector(".ct-language").disabled,
  );
  const width = () =>
    app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.find((v) =>
            v.webContents?.getURL().startsWith("https://web.whatsapp.com"),
          )
          .getBounds().width,
    );
  const expanded = await width();
  await page.getByRole("button", { name: "折叠客户工具", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(".customer-sidebar").classList.contains("is-collapsed"),
  );
  assert.equal(await width(), expanded + 288);
  await page.getByRole("button", { name: "展开客户工具", exact: true }).click();
  await page.locator(".ct-panel").waitFor();
  await page.locator(".ct-language").selectOption("ja");
  await page.getByText("已保存当前客户的翻译语言", { exact: true }).waitFor();
  await page.getByRole("button", { name: "新建标签", exact: true }).click();
  let d = page.getByRole("dialog", { name: "新建客户标签" });
  await d.locator("input").fill("重点跟进");
  await d.getByRole("button", { name: "创建标签" }).click();
  await d.waitFor({ state: "hidden" });
  await page.locator(".ct-tag-select").selectOption({ label: "重点跟进" });
  await page.getByRole("button", { name: "重点跟进 ×" }).waitFor();
  await page.getByRole("button", { name: "客户资料 / 备注", exact: true }).click();
  await page.locator("[data-field=name]").fill("ERIC 重点客户");
  await page.locator("[data-field=level]").selectOption("核心");
  await page.locator(".ct-notes").fill("客户约定周五回访");
  await page.getByRole("button", { name: "保存资料", exact: true }).click();
  await page.getByText("客户资料与备注已保存", { exact: true }).waitFor();
  await page.locator(".ct-notes").fill("客户约定周五回访（尚未保存）");
  await page.evaluate(() => window.gongdan.refresh());
  assert.equal(await page.locator(".ct-notes").inputValue(), "客户约定周五回访（尚未保存）");
  const switchCustomer = async (identifier) => {
    await native(
      `document.querySelector('#main [data-id]').dataset.id='false_${identifier}@s.whatsapp.net_FIXTURE'`,
    );
    await page.waitForFunction(
      (id) =>
        document.querySelector(".ct-customer small")?.textContent === id &&
        !document.querySelector(".ct-language").disabled,
      identifier,
    );
  };
  await switchCustomer("447410419513");
  assert.equal(await page.locator(".ct-notes").inputValue(), "");
  assert.equal(await page.locator(".ct-language").inputValue(), "en");
  await switchCustomer("447410419512");
  assert.equal(await page.locator(".ct-notes").inputValue(), "客户约定周五回访（尚未保存）");
  assert.equal(await page.locator(".ct-language").inputValue(), "ja");
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  assert.equal(await page.locator(".ct-notes").inputValue(), "客户约定周五回访");
  await page.screenshot({ path: ".runtime/desktop-customer-profile.png" });
  await page.getByRole("button", { name: "聊天工具", exact: true }).click();
  await page.getByRole("button", { name: "新增话术", exact: true }).click();
  d = page.getByRole("dialog", { name: "新增话术" });
  await d.locator("[name=title]").fill("发货通知");
  await d.locator("[name=category]").fill("售后");
  await d.locator("[name=body]").fill("货已发出，预计四天到达。");
  await d.getByRole("button", { name: "保存", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /发货通知.*货已发出/ }).click();
  d = page.getByRole("dialog", { name: "发送预览" });
  await d.getByRole("button", { name: "放入当前聊天" }).click();
  await d.waitFor({ state: "hidden" });
  assert.equal(
    await native(`document.querySelector('#main footer [contenteditable]').textContent`),
    "货已发出，预计四天到达。",
  );
  // Existing drafts and changed recipients must never be overwritten.
  await page.getByRole("button", { name: /发货通知.*货已发出/ }).click();
  d = page.getByRole("dialog", { name: "发送预览" });
  await d.getByRole("button", { name: "放入当前聊天" }).click();
  await d.getByText("聊天输入框已有草稿，请先发送或清空草稿", { exact: true }).waitFor();
  await d.getByRole("button", { name: "关闭", exact: true }).click();
  await switchCustomer("447410419513");
  const rejected = await page.evaluate(
    async (context) => {
      try {
        await window.gongdan.prepareQuick(context, { text: "wrong customer" });
        return false;
      } catch {
        return true;
      }
    },
    { accountId, identifier: "447410419512", name: "ERIC" },
  );
  assert(rejected, "stale customer insertion accepted");
  await switchCustomer("447410419512");
  await native(`document.querySelector('#main footer [contenteditable]').textContent=''`);
  await page.getByRole("button", { name: "新增图片", exact: true }).click();
  d = page.getByRole("dialog", { name: "新增快捷图片" });
  await d.locator("[name=title]").fill("报价表");
  const png = await app.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(
        Buffer.from([0, 140, 0, 255, 0, 140, 0, 255, 0, 140, 0, 255, 0, 140, 0, 255]),
        { width: 2, height: 2 },
      )
      .toPNG()
      .toString("base64"),
  );
  await d
    .locator("[name=image]")
    .setInputFiles({
      name: "quote.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
  await d.getByRole("button", { name: "保存", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  await page.locator(".ct-image-library .ct-asset-use").filter({ hasText: "报价表" }).click();
  d = page.getByRole("dialog", { name: "发送预览" });
  await d.getByRole("button", { name: "放入当前聊天" }).click();
  await d.waitFor({ state: "hidden" });
  for (
    let i = 0;
    i < 30 &&
    !(await native(`document.documentElement.dataset.gd7Paste||''`)).includes("image/png");
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.match(
    await native(`document.documentElement.dataset.gd7Paste||''`),
    /image\/png/,
    "native paste did not receive image",
  );
  await page.screenshot({ path: ".runtime/desktop-customer-tools.png" });
  console.log(
    "Customer sidebar: profiles/drafts, languages, tags, collapse, native text and image preparation passed.",
  );
}
