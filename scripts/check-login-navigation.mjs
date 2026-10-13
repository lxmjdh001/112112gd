// Browser regression checks with synthetic authentication; no accounts or live sessions are changed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.GONGDAN_ADMIN_URL || 'http://127.0.0.1:5779/';
const browser = await chromium.launch({ headless: true });
const errors = [], unexpected = [], passed = [];
async function fixture() {
  const context = await browser.newContext();
  const sessions = new Set();
  let sequence = 0;
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const token = request.headers().authorization?.replace(/^Bearer /, '');
    let data;
    if (path === '/auth/registration') data = { enabled: false };
    else if (path === '/auth/login') {
      const accessToken = `navigation-fixture-${++sequence}`;
      sessions.add(accessToken);
      data = { accessToken };
    } else if (path === '/auth/logout') {
      sessions.delete(token);
      data = true;
    } else if (!sessions.has(token)) {
      return route.fulfill({ status: 401, json: { code: 401, message: '登录状态已失效' } });
    } else if (path === '/user/info') {
      data = { userId: 'fixture', username: 'fixture', realName: '测试管理员', roles: ['admin'], homePath: '/dashboard', avatar: '/logo.svg' };
    } else if (path === '/auth/codes' || path === '/platform-accounts') data = [];
    else if (path === '/dashboard') data = { codes: 0, devices: 0, accounts: 0, proxies: 0 };
    else { unexpected.push(path); return route.fulfill({ status: 500 }); }
    await route.fulfill({ json: { code: 0, data } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', e => errors.push(e.message));
  return { context, page, sessions };
}
async function login(page, target = '/dashboard', heading = '工作台') {
  await page.locator('#username').fill('navigation-fixture');
  await page.locator('#password').fill('synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(url => url.hash === '#' + target);
  await page.getByRole('heading', { name: heading, exact: true }).waitFor();
}
try {
  const { context, page, sessions } = await fixture();
  await page.goto(base + '#/home');
  await page.getByRole('link', { name: '登录后台', exact: true }).click();
  await login(page);
  passed.push('homepage login opens dashboard');

  // The token is retained in browser storage, but its server session has expired.
  sessions.clear();
  await page.goto(base + '#/home');
  await page.reload();
  await page.getByRole('link', { name: '登录后台', exact: true }).click();
  await page.locator('#username').waitFor();
  await login(page);
  passed.push('expired saved session from homepage returns to dashboard after login');

  await page.goto(base + '#/home');
  await page.reload();
  await page.getByRole('link', { name: '登录后台', exact: true }).click();
  await page.waitForURL(url => url.hash === '#/dashboard');
  await page.getByRole('heading', { name: '工作台', exact: true }).waitFor();
  passed.push('authenticated homepage entry opens dashboard without another login');

  await page.goto(base + '#/auth/login?redirect=%252Fhome');
  await page.waitForURL(url => url.hash === '#/dashboard');
  passed.push('authenticated legacy public redirect falls back to dashboard');
  await context.close();

  for (const target of ['/home', '/', '/auth/login', 'https://example.invalid/', '%broken']) {
    const f = await fixture();
    await f.page.goto(base + '#/auth/login?redirect=' + encodeURIComponent(encodeURIComponent(target)));
    await login(f.page);
    passed.push(`login redirect ${target} falls back to dashboard`);
    await f.context.close();
  }
  // Keep a requested admin page, including literal-percent query values and fragments.
  for (const legacy of [false, true]) {
    const f = await fixture();
    const target = '/platform-accounts?label=50%25#details';
    if (legacy) {
      await f.page.goto(base + '#/auth/login?redirect=' + encodeURIComponent(encodeURIComponent(target)));
    } else {
      await f.page.goto(base + '#' + target);
    }
    await login(f.page, target, '账号列表');
    passed.push(legacy ? 'legacy encoded admin return path preserved' : 'direct admin page returns after login with query and fragment intact');
    await f.context.close();
  }
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed, errors }));
} finally {
  await browser.close();
}
