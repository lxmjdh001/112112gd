<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import "./home.css";
const selected = ref(0),
  accounts = ref(5),
  days = ref(20),
  menu = ref(false);
const conversations = [
  {
    name: "Sofia",
    country: "西班牙语",
    initial: "S",
    message: "¿Podrían enviarme el catálogo de esta temporada?",
    translated: "可以发一份本季的产品目录吗？",
    reply: "当然，我给您发最新的目录。",
    preview: "Claro, le envío nuestro catálogo más reciente.",
    color: "coral",
  },
  {
    name: "Lucas",
    country: "葡萄牙语",
    initial: "L",
    message: "Vocês podem enviar uma amostra primeiro?",
    translated: "你们可以先寄一份样品吗？",
    reply: "可以，请把您的收货地址发给我。",
    preview: "Sim, por favor, envie seu endereço de entrega.",
    color: "mint",
  },
  {
    name: "Emma",
    country: "英语",
    initial: "E",
    message: "When will the new collection be available?",
    translated: "新系列什么时候上市？",
    reply: "预计下周，我会及时通知您。",
    preview: "We expect it next week. I'll keep you updated.",
    color: "lavender",
  },
];
const chat = computed(() => conversations[selected.value]!);
const count = computed(() => Math.max(1, Math.min(500, Number(accounts.value) || 1)));
const duration = computed(() => Math.max(1, Math.min(365, Number(days.value) || 1)));
const cost = computed(() => count.value * duration.value);
const features = [
  {
    n: "01",
    title: "让语言，成为沟通的助力",
    body: "来信自动显示中文译文；用中文写回复，先看译文再发送。每位客户可以设置自己的沟通语言。",
    tag: "收发双向翻译",
    cls: "translation",
  },
  {
    n: "02",
    title: "多个账号，一个工作空间",
    body: "WhatsApp 扫码账号与 API 号码清晰分组。独立登录环境，可用本机网络，也可为账号指定代理 IP。",
    tag: "多账号工作台",
    cls: "accounts",
  },
  {
    n: "03",
    title: "每次回复，都能快一点",
    body: "常用回复和产品图片收进素材库。点击预览、确认发送，让每次回复都更从容。",
    tag: "话术与图片素材",
    cls: "assets",
  },
  {
    n: "04",
    title: "客户的每个细节，都有记录",
    body: "随手打标签、记录偏好和跟进备注。同团队、同平台识别重复客户，让下一次跟进有据可查。",
    tag: "客户资料与去重",
    cls: "customers",
  },
];
const platforms = [
  { name: "WhatsApp", detail: "扫码登录", icon: "whatsapp.svg" },
  { name: "WhatsApp API", detail: "官方接口", icon: "whatsapp.svg" },
  { name: "LINE", detail: "独立登录", icon: "line.png" },
  { name: "Telegram", detail: "独立登录", icon: "telegram.svg" },
];
const faqs = [
  [
    "什么时候扣点？不开电脑会扣吗？",
    "每个实际平台账号，在北京时间当天首次上线使用时扣 1 点。同一天重复打开、切换客户端，或移除后重新添加同一个账号，都不会重复扣点。当天没在软件里上线就不扣；只创建号位、等待扫码或查看管理后台也不扣。",
  ],
  [
    "100 点是怎么赠送的？",
    "新注册公司账户自动获得 100 点，整个公司团队共享。赠送按公司注册发放一次，不是每添加一个社交账号再赠送。",
  ],
  [
    "点数用完会发生什么？",
    "点数不足时，可使用公司累计 3 天缓冲。只累计实际上线使用的北京时间自然日，同一天多个账号共用这一天缓冲；充值不会重置已用天数。缓冲用完后，逾期未充值会强制退登全部账号，充值后需重新登录。",
  ],
  [
    "翻译字符和员工席位也收费吗？",
    "D1 Scrm 的文字翻译和员工席位不单独收费，按实际上线的平台账号消耗点数。第三方平台自身收取的费用不包含在软件点数中。",
  ],
  [
    "现在支持哪些平台？",
    "支持 WhatsApp、LINE 和 Telegram 的客户端登录，以及 WhatsApp API。各平台账号沿用相同的按日计费规则。WhatsApp 支持消息自动翻译；LINE 和 Telegram 目前支持选中文字翻译。",
  ],
];
function go(id: string) {
  menu.value = false;
  document.getElementById(id)?.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
}
</script>

<template>
  <div class="gd-home">
    <header class="home-nav">
      <div class="home-nav-inner home-wrap">
        <RouterLink class="home-brand" to="/home" aria-label="D1 Scrm 首页">
          <span class="brand-mark">D1</span><b>D1 <span>Scrm</span></b>
        </RouterLink>
        <nav id="home-navigation" :class="{ open: menu }" aria-label="主页导航">
          <button @click="go('product')">产品能力</button>
          <button @click="go('workflow')">如何开始</button>
          <button @click="go('pricing')">透明计费</button>
          <button @click="go('download')">客户端下载</button>
          <button @click="go('faq')">常见问题</button>
        </nav>
        <div class="nav-actions">
          <RouterLink class="nav-login" to="/dashboard">登录后台</RouterLink>
          <RouterLink class="home-button primary nav-start" to="/auth/register"
            >免费开始 <span>↗</span></RouterLink
          >
          <button
            class="mobile-menu"
            :aria-expanded="menu"
            aria-controls="home-navigation"
            aria-label="展开导航"
            @click="menu = !menu"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
        </div>
      </div>
    </header>

    <main>
      <section class="home-hero">
        <div class="hero-grid" aria-hidden="true"></div>
        <div class="home-wrap hero-content">
          <div class="hero-copy">
            <div class="hero-kicker">
              <span class="kicker-mark">D1</span> 为跨境沟通而生
              <span class="kicker-divider">/</span> D1 工单
            </div>
            <h1>连接全球客户，<br /><em>从容处理每一次对话。</em></h1>
            <p>
              多账号、免费翻译、客户跟进，一个工作台就够。<br
                class="desktop-break"
              />让沟通更专注，让团队协作更有条理。
            </p>
            <div class="home-buttons">
              <RouterLink class="home-button primary" to="/auth/register"
                >免费开始 · 领取 100 点 <span>↗</span></RouterLink
              >
              <button class="home-button secondary" @click="go('download')">
                下载客户端 <span>↓</span>
              </button>
            </div>
            <div class="hero-note">
              <span>✓ 翻译免费</span><span>✓ 无需绑卡</span><span>✓ 上线当天才计费</span>
            </div>
          </div>

          <div id="workspace-demo" class="hero-product">
            <div class="demo-window">
              <div class="demo-title">
                <div>
                  <span class="window-mark">D1</span><b>客户沟通工作台</b
                  ><span class="demo-title-divider"></span><span>所有对话，有序连接</span>
                </div>
                <small><span></span>交互演示</small>
              </div>
              <div class="demo-body">
                <aside class="demo-rail" aria-hidden="true">
                  <span class="rail-active"
                    ><svg viewBox="0 0 24 24">
                      <path
                        d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2ZM7 9h10M7 13h6"
                      /></svg
                  ></span>
                  <span
                    ><svg viewBox="0 0 24 24">
                      <path
                        d="M16 21v-2a5 5 0 0 0-10 0v2M11 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM18 5a4 4 0 0 1 0 7M19 16a4 4 0 0 1 3 4"
                      /></svg
                  ></span>
                  <span
                    ><svg viewBox="0 0 24 24"><path d="M4 5h16v15H4zM4 10h16M9 10v10" /></svg
                  ></span>
                  <span class="rail-bottom">D1</span>
                </aside>
                <div class="demo-people">
                  <div class="demo-section-label"><b>我的会话</b><span>3</span></div>
                  <div class="demo-search">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="10" cy="10" r="6" />
                      <path d="m15 15 5 5" /></svg
                    >选择客户，体验翻译
                  </div>
                  <button
                    v-for="(item, index) in conversations"
                    :key="item.name"
                    :class="{ active: selected === index }"
                    :aria-pressed="selected === index"
                    @click="selected = index"
                  >
                    <span class="demo-avatar" :class="item.color">{{ item.initial }}</span>
                    <span class="person-name"
                      ><b>{{ item.name }}</b
                      ><small>{{ item.country }} · 产品咨询</small></span
                    >
                    <i v-if="selected === index" aria-hidden="true"></i>
                  </button>
                  <div class="demo-account">
                    <img src="/platforms/whatsapp.svg" alt="" />
                    <div><b>WhatsApp</b><span>独立账号环境</span></div>
                    <i></i>
                  </div>
                </div>
                <div class="demo-chat">
                  <div class="demo-contact">
                    <div>
                      <b>{{ chat.name }}</b
                      ><small>{{ chat.country }} · 客户语言</small>
                    </div>
                    <span class="auto-badge">文 / A <span>自动翻译</span></span>
                  </div>
                  <div class="demo-conversation" aria-live="polite">
                    <div class="conversation-date">今天 · 对话示例</div>
                    <div class="demo-bubble">
                      {{ chat.message }}<span><small>译</small>{{ chat.translated }}</span>
                    </div>
                    <div class="demo-bubble outbound">
                      {{ chat.reply }}<span><small>译</small>{{ chat.preview }}</span>
                    </div>
                  </div>
                  <div class="demo-compose">
                    <div><span>回复预览</span><small>确认后发送</small></div>
                    <p>{{ chat.preview }}</p>
                    <div class="compose-bottom">
                      <span>＋ <i>图片</i> <i>话术</i></span
                      ><span class="demo-send" aria-hidden="true">↑</span>
                    </div>
                  </div>
                </div>
                <aside class="demo-profile">
                  <div class="profile-heading">客户信息 <span>↗</span></div>
                  <span class="demo-avatar profile-avatar" :class="chat.color">{{
                    chat.initial
                  }}</span
                  ><b>{{ chat.name }}</b
                  ><small>WhatsApp · {{ chat.country }}</small>
                  <div class="profile-block">
                    <span>客户标签</span>
                    <div class="demo-tags"><span>潜在客户</span><span>跟进中</span></div>
                  </div>
                  <div class="profile-block">
                    <span>沟通语言</span>
                    <p>{{ chat.country }} <span>⌄</span></p>
                  </div>
                  <div class="profile-block">
                    <span>跟进备注</span>
                    <p class="profile-note">正在了解产品信息，<br />下次沟通继续跟进。</p>
                  </div>
                  <div class="profile-saved">✓ 每一次沟通，都有记录</div>
                </aside>
              </div>
            </div>
            <div class="demo-caption">
              <span>对话、翻译、客户资料，同屏处理。</span
              ><span>点击左侧客户，切换语言演示 <span>↖</span></span>
            </div>
          </div>
        </div>
      </section>

      <section class="home-platforms home-wrap" aria-label="已支持的平台">
        <div class="platform-heading"><span>你的客户在哪里</span><b>D1 就连接到哪里</b></div>
        <div v-for="platform in platforms" :key="platform.name" class="platform-item">
          <img :src="`/platforms/${platform.icon}`" alt="" />
          <div>
            <b>{{ platform.name }}</b
            ><small>{{ platform.detail }}</small>
          </div>
        </div>
      </section>

      <section id="product" class="home-features home-wrap">
        <div class="section-heading">
          <div>
            <span class="section-kicker">为日常沟通，准备好每一个工具</span>
            <h2>从第一句问候，<br />到下一次客户跟进。</h2>
          </div>
          <p>把分散的操作连接起来。<br />需要的工具，始终在对话旁边。</p>
        </div>
        <div class="feature-grid">
          <article v-for="f in features" :key="f.n" class="feature-card" :class="f.cls">
            <div class="feature-label">
              <span>{{ f.n }}</span
              >{{ f.tag }}
            </div>
            <h3>{{ f.title }}</h3>
            <p>{{ f.body }}</p>
            <div
              v-if="f.cls === 'translation'"
              class="feature-visual translation-visual"
              aria-hidden="true"
            >
              <div><span>客户来信</span><b>Olá, gostaria de saber mais.</b></div>
              <span class="visual-arrow">↓</span>
              <div><span>中文译文</span><b>您好，我想了解更多信息。</b><i>免费</i></div>
            </div>
            <div
              v-else-if="f.cls === 'accounts'"
              class="feature-visual accounts-visual"
              aria-hidden="true"
            >
              <div
                v-for="platform in platforms.filter((p) => p.name !== 'WhatsApp API')"
                :key="platform.name"
              >
                <img :src="`/platforms/${platform.icon}`" alt="" /><b>{{ platform.name }}</b
                ><span>独立环境</span><i>✓</i>
              </div>
            </div>
            <div
              v-else-if="f.cls === 'assets'"
              class="feature-visual assets-visual"
              aria-hidden="true"
            >
              <div class="asset-file">
                <svg viewBox="0 0 48 48">
                  <path d="M10 5h20l9 9v29H10ZM29 5v11h10M17 25h15M17 32h11" /></svg
                ><span>产品资料</span>
              </div>
              <div class="asset-reply">
                <small>快捷话术 / 发货通知</small>
                <p>您好，您的订单已发出，<br />请留意物流信息。</p>
                <span>预览后发送 ↗</span>
              </div>
            </div>
            <div v-else class="feature-visual customers-visual" aria-hidden="true">
              <div class="mini-customer">
                <span class="demo-avatar">S</span>
                <div><b>Sofia</b><small>客户资料</small></div>
                <span class="mini-tag">重点跟进</span>
              </div>
              <div class="customer-timeline">
                <i></i>
                <div><b>已发送产品目录</b><span>记录偏好，让下一次沟通更顺畅</span></div>
              </div>
            </div>
          </article>
        </div>
        <p class="feature-disclaimer">
          WhatsApp 支持收发自动翻译；LINE、Telegram 目前支持选中文字翻译。
        </p>
      </section>

      <section id="workflow" class="workflow-section">
        <div class="home-wrap">
          <div class="section-heading">
            <div>
              <span class="section-kicker">简单开始</span>
              <h2>三个步骤，进入工作状态。</h2>
            </div>
            <RouterLink class="text-link" to="/auth/register"
              >创建工作空间 <span>↗</span></RouterLink
            >
          </div>
          <ol class="workflow-steps">
            <li>
              <span class="step-number">01</span>
              <h3>创建公司账户</h3>
              <p>注册领取 100 点，进入管理后台，<br />为团队生成客户端登录码。</p>
            </li>
            <li>
              <span class="step-number">02</span>
              <h3>连接你的平台账号</h3>
              <p>
                在客户端登录 WhatsApp、LINE 或 Telegram，<br />也可接入已分配的 WhatsApp API 号码。
              </p>
            </li>
            <li>
              <span class="step-number">03</span>
              <h3>开始沟通与跟进</h3>
              <p>使用翻译、话术、图片和客户资料，<br />把每一次对话顺畅地接下去。</p>
            </li>
          </ol>
        </div>
      </section>

      <section id="pricing" class="home-pricing home-wrap">
        <div class="section-heading">
          <div>
            <span class="section-kicker">清楚的价格，简单的使用方式</span>
            <h2>只为当天上线的账号付费。</h2>
          </div>
          <p>不按翻译字数计费。<br />不额外收取员工席位费。</p>
        </div>
        <div class="pricing-layout">
          <article class="price-plan">
            <span class="plan-label">按实际使用计费</span>
            <div class="plan-amount">
              <strong>1</strong>
              <div><b>点 / 账号 / 天</b><span>1 点 = 1 元</span></div>
            </div>
            <p>各平台相同规则，每个账号当天只扣一次。</p>
            <ul>
              <li>当天未上线，不扣点</li>
              <li>文字翻译免费，员工席位免费</li>
              <li>公司累计享有 3 天余额不足缓冲</li>
            </ul>
            <RouterLink class="home-button" to="/auth/register"
              >新公司注册，领取 100 点 <span>↗</span></RouterLink
            ><small>缓冲天数用完不再提供，逾期需充值并重新登录。</small>
          </article>
          <div class="price-calculator">
            <div class="calculator-heading">
              <span class="section-kicker">费用试算</span>
              <h3>按你的团队规模，算一算。</h3>
              <p>假设这些账号在选定天数内每天都上线</p>
            </div>
            <div class="calculator-fields">
              <label
                >上线账号数量
                <div>
                  <input
                    v-model.number="accounts"
                    type="number"
                    min="1"
                    max="500"
                    aria-label="上线账号数量"
                  /><span>个</span>
                </div></label
              ><span class="multiply">×</span
              ><label
                >使用天数
                <div>
                  <input
                    v-model.number="days"
                    type="number"
                    min="1"
                    max="365"
                    aria-label="使用天数"
                  /><span>天</span>
                </div></label
              >
            </div>
            <div class="calculator-total">
              <span>预计消耗</span
              ><output aria-live="polite"
                ><b>{{ cost.toLocaleString() }}</b> 点<small
                  >约 {{ cost.toLocaleString() }} 元</small
                ></output
              >
            </div>
            <div class="calculator-gift">
              <span>100</span>
              <div>
                <b>新公司免费体验点数</b>
                <p>每天 {{ count }} 个账号，可覆盖 {{ Math.floor(100 / count) }} 个完整使用日。</p>
              </div>
            </div>
          </div>
        </div>
        <p class="price-footnote">
          按北京时间自然日计费。未上线的日期不扣点，余额不足请联系平台充值。第三方平台自身费用另计。
        </p>
      </section>

      <section id="download" class="home-download">
        <div class="home-wrap">
          <div class="download-heading">
            <div>
              <span class="section-kicker">客户端下载</span>
              <h2>你的工作台，随时就位。</h2>
              <p>下载 D1 Scrm，在电脑上开启客户沟通。</p>
            </div>
            <span class="download-version"><i></i> v0.1.9 · 桌面客户端</span>
          </div>
          <div class="download-grid">
            <article class="download-card">
              <div class="download-os">
                <span class="download-os-icon windows-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path
                      d="M2 4.3 10.5 3v8H2zm10-1.6L22 1.3V11h-10zM2 12.5h8.5v8L2 19.2zm10 0h10v9.7l-10-1.5z"
                    />
                  </svg>
                </span>
                <div>
                  <h3>Windows</h3>
                  <p>Windows 10 / 11 · 64 位</p>
                </div>
                <span class="download-format">EXE</span>
              </div>
              <p class="download-description">下载安装，登录后开始工作。</p>
              <a
                class="home-button primary download-primary"
                href="/client-downloads/0.1.9/D1-Scrm-0.1.9-windows-x64-setup.exe"
                download
              >
                下载 Windows 版 <span aria-hidden="true">↓</span>
              </a>
              <span class="download-caption">适用于 Intel / AMD 处理器</span>
            </article>
            <article class="download-card">
              <div class="download-os">
                <span class="download-os-icon apple-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path
                      d="M17.4 12.8c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.7.8-3.4.8-.7 0-1.8-.8-2.9-.7-1.5 0-2.8.9-3.6 2.2-1.5 2.6-.4 6.4 1.1 8.5.7 1 1.5 2.1 2.6 2.1 1 0 1.4-.7 2.8-.7 1.3 0 1.7.7 2.9.7s1.9-1 2.6-2c.8-1.2 1.2-2.3 1.2-2.3s-2.3-.9-2.3-3.3zM15.2 6.1c.6-.8 1.1-1.9 1-3-.9 0-2 .6-2.7 1.4-.6.7-1.2 1.8-1.1 2.8 1 .1 2.1-.5 2.8-1.2z"
                    />
                  </svg>
                </span>
                <div>
                  <h3>macOS</h3>
                  <p>macOS 13 Ventura 及以上</p>
                </div>
                <span class="download-format">DMG</span>
              </div>
              <p class="download-description">选择 Mac 芯片，拖入「应用程序」即可安装。</p>
              <div class="download-mac-actions">
                <a
                  class="home-button primary"
                  href="/client-downloads/0.1.9/D1-Scrm-0.1.9-mac-arm64.dmg"
                  download
                  >苹果芯片版 <span aria-hidden="true">↓</span></a
                >
                <a
                  class="home-button secondary"
                  href="/client-downloads/0.1.9/D1-Scrm-0.1.9-mac-x64.dmg"
                  download
                  >Intel 芯片版 <span aria-hidden="true">↓</span></a
                >
              </div>
              <span class="download-caption">点击左上角  →「关于本机」查看芯片类型</span>
            </article>
          </div>
          <div class="download-guide">
            <p>
              <span>01 注册公司账户</span><b aria-hidden="true">→</b><span>02 在后台生成登录码</span
              ><b aria-hidden="true">→</b><span>03 下载客户端并登录</span>
            </p>
            <RouterLink class="text-link" to="/dashboard">获取登录码 <span>↗</span></RouterLink>
          </div>
          <details class="download-help">
            <summary>安装说明与版本校验 <span>+</span></summary>
            <div>
              <p>
                当前为体验版。Windows 安装包尚未配置数字签名；Mac 版本尚未完成 Apple
                公证，首次打开可能收到系统安全提示。请仅使用本页下载的安装包，并按系统提示在安全设置中确认来源后打开。
              </p>
              <p>
                Mac：打开 DMG，将 D1 Scrm 拖到「应用程序」。若系统阻止打开，可在「系统设置 →
                隐私与安全性」中查看并确认。Windows：运行 EXE，按安装向导完成安装。
              </p>
              <a class="text-link" href="/client-downloads/0.1.9/SHA256SUMS" download
                >下载 SHA-256 校验文件 <span>↓</span></a
              >
            </div>
          </details>
        </div>
      </section>

      <section id="faq" class="home-faq home-wrap">
        <div class="faq-heading">
          <span class="section-kicker">常见问题</span>
          <h2>开始之前，你可能想了解。</h2>
          <RouterLink class="text-link" to="/account-center"
            >查看充值说明 <span>↗</span></RouterLink
          >
        </div>
        <div class="faq-list">
          <details v-for="([q, a], index) in faqs" :key="q" :open="index === 0">
            <summary>
              <span class="faq-number">0{{ index + 1 }}</span
              >{{ q }}<span class="faq-toggle">+</span>
            </summary>
            <p>{{ a }}</p>
          </details>
        </div>
      </section>

      <section class="home-cta">
        <div class="home-wrap cta-inner">
          <div>
            <span class="cta-kicker">让工作空间，跟上你的业务。</span>
            <h2>现在开始，用 D1 连接客户。</h2>
            <p>新公司注册赠送 100 点 · 免费文字翻译 · 按天计费</p>
          </div>
          <RouterLink class="home-button" to="/auth/register"
            >创建免费账户 <span>↗</span></RouterLink
          >
        </div>
      </section>
    </main>

    <footer class="home-footer home-wrap">
      <div class="footer-main">
        <RouterLink class="home-brand" to="/home"
          ><span class="brand-mark">D1</span><b>D1 <span>Scrm</span></b></RouterLink
        >
        <p>D1 工单，让客户沟通更有条理。</p>
        <RouterLink to="/dashboard">进入管理后台 ↗</RouterLink>
      </div>
      <div class="footer-bottom">
        <span>© {{ new Date().getFullYear() }} D1 Scrm</span
        ><span>多账号管理 / 免费翻译 / 客户跟进</span>
      </div>
    </footer>
  </div>
</template>
