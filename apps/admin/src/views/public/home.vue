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
    title: "外语进来，中文看懂。",
    body: "来信自动显示中文译文；用中文写回复，先看译文再发送。每位客户可以设置自己的沟通语言。",
    tag: "收发双向翻译",
    cls: "orange",
  },
  {
    n: "02",
    title: "账号分开，工作集中。",
    body: "WhatsApp 扫码账号与 API 号码清晰分组。独立登录环境，可用本机网络，也可为账号指定代理 IP。",
    tag: "多账号工作台",
    cls: "green",
  },
  {
    n: "03",
    title: "好用的话，不用反复打。",
    body: "常用回复和产品图片收进素材库。点击预览、确认发送，让每次回复都更从容。",
    tag: "话术与图片素材",
    cls: "purple",
  },
  {
    n: "04",
    title: "下次见面，还记得客户。",
    body: "随手打标签、记录偏好和跟进备注。同团队、同平台识别底库重复客户，信息接得上。",
    tag: "客户资料与去重",
    cls: "blue",
  },
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
    "工单007 的文字翻译和员工席位不单独收费，按实际上线的平台账号消耗点数。第三方平台自身收取的费用不包含在软件点数中。",
  ],
  [
    "现在支持哪些平台？",
    "目前已接通 WhatsApp 扫码登录和 WhatsApp API。其他平台接入后沿用同样的账号按日计费规则，客户端中未开放的平台会明确标注。",
  ],
];
function go(id: string) {
  menu.value = false;
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
</script>

<template>
  <div class="gd-home">
    <header class="home-nav">
      <RouterLink class="home-brand" to="/home"
        ><span>007</span>工单007<i>让沟通有条不紊</i></RouterLink
      >
      <button class="mobile-menu" :aria-expanded="menu" aria-label="展开导航" @click="menu = !menu">
        ☰
      </button>
      <nav :class="{ open: menu }" aria-label="主页导航">
        <button @click="go('product')">产品能力</button
        ><button @click="go('workflow')">如何开始</button
        ><button @click="go('pricing')">透明计费</button
        ><button @click="go('faq')">常见问题</button>
      </nav>
      <RouterLink class="nav-login" to="/dashboard">进入管理后台 <span>↗</span></RouterLink>
    </header>

    <main>
      <section class="home-hero home-wrap">
        <div class="hero-copy">
          <div class="home-eyebrow"><span></span> 为跨境沟通，留出更多可能</div>
          <h1>客户在世界各地。<br />你的工作台，<br /><em>只有一个。</em></h1>
          <p>把多账号、免费翻译和客户跟进放在一起。<br />少一点来回切换，多一点认真沟通。</p>
          <div class="home-buttons">
            <RouterLink class="home-button primary" to="/auth/register"
              >免费开始 · 领取 100 点 <span>↗</span></RouterLink
            ><button class="home-button ghost" @click="go('product')">
              看看怎么用 <span>↓</span>
            </button>
          </div>
          <div class="hero-note">
            <span>✓ 无需绑卡</span><span>✓ 翻译免费</span><span>✓ 上线当天才扣点</span>
          </div>
        </div>
        <div class="hero-product">
          <div class="orbit-label">CONNECTED, NOT COMPLICATED.</div>
          <div class="demo-window">
            <div class="demo-title">
              <span class="window-dots"><i></i><i></i><i></i></span><b>工单007 / 聊天工作台</b
              ><small>功能演示</small>
            </div>
            <div class="demo-body">
              <div class="demo-people">
                <span class="demo-section-label">会话</span
                ><button
                  v-for="(item, index) in conversations"
                  :key="item.name"
                  :class="{ active: selected === index }"
                  :aria-pressed="selected === index"
                  @click="selected = index"
                >
                  <span class="demo-avatar" :class="item.color">{{ item.initial }}</span
                  ><span
                    ><b>{{ item.name }}</b
                    ><small>{{ item.country }}</small></span
                  >
                </button>
                <div class="demo-account">WhatsApp<br /><span>独立账号环境</span></div>
              </div>
              <div class="demo-chat">
                <div class="demo-contact">
                  <span class="demo-avatar" :class="chat.color">{{ chat.initial }}</span>
                  <div>
                    <b>{{ chat.name }}</b
                    ><small>{{ chat.country }} · 客户语言</small>
                  </div>
                  <span class="auto-badge">自动翻译</span>
                </div>
                <div class="demo-conversation" aria-live="polite">
                  <div class="demo-bubble">
                    {{ chat.message }}<span>{{ chat.translated }}</span>
                  </div>
                  <div class="demo-bubble outbound">
                    {{ chat.reply }}<span>{{ chat.preview }}</span>
                  </div>
                  <div class="demo-tags"><span>潜在客户</span><span>跟进中</span></div>
                </div>
                <div class="demo-compose">
                  <small>译文预览 · 确认后发送</small>
                  <p>{{ chat.preview }}</p>
                  <div>
                    <span>{{ chat.reply }}</span
                    ><span class="demo-send" aria-hidden="true">↑</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="floating-note">
            <span>文 / A</span>
            <div><b>对话继续，语言不设限。</b><small>收发双向自动翻译 · 0 字符费用</small></div>
          </div>
        </div>
      </section>

      <div class="home-platforms home-wrap">
        <span>两种接入方式，同一个工作台</span><b><i>◉</i> WhatsApp <small>扫码登录</small></b
        ><b><i>◉</i> WhatsApp API <small>官方接口</small></b
        ><span class="platform-more">更多平台，持续接入中 ↗</span>
      </div>

      <section id="product" class="home-features home-wrap">
        <div class="section-heading">
          <div>
            <span class="home-eyebrow">01 / LESS FRICTION</span>
            <h2>把琐碎的操作收起来，<br />把完整的注意力留给客户。</h2>
          </div>
          <p>从第一句问候到下一次跟进，<br />需要的工具，就在对话旁边。</p>
        </div>
        <div class="feature-grid">
          <article v-for="f in features" :key="f.n" class="feature-card" :class="f.cls">
            <div class="feature-top">
              <span>{{ f.n }}</span
              ><span>↗</span>
            </div>
            <h3>{{ f.title }}</h3>
            <p>{{ f.body }}</p>
            <div class="feature-bottom">{{ f.tag }}<span>+</span></div>
          </article>
        </div>
      </section>

      <section id="workflow" class="workflow-section">
        <div class="home-wrap workflow-inner">
          <div>
            <span class="home-eyebrow">02 / READY WHEN YOU ARE</span>
            <h2>从这里开始，<br />连接你的下一位客户。</h2>
            <RouterLink class="text-link" to="/auth/register">创建你的工作空间 ↗</RouterLink>
          </div>
          <ol>
            <li>
              <span>1</span>
              <div>
                <h3>注册公司账户</h3>
                <p>领取 100 点，在管理后台生成员工登录码，勾选可用平台。</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <h3>登录客户端，添加账号</h3>
                <p>扫码登录 WhatsApp，或打开已分配的 API 号码；按需设置独立 IP。</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <h3>开始聊，记住每次沟通</h3>
                <p>看译文、发话术、加标签、做备注，团队账号与点数使用清晰可查。</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section id="pricing" class="home-pricing home-wrap">
        <div class="section-heading">
          <div>
            <span class="home-eyebrow">03 / PAY FOR THE DAYS YOU USE</span>
            <h2>费用很简单。<br /><em>上线的账号，按天算。</em></h2>
          </div>
          <p>不按翻译字数计费，不收员工席位费。<br />1 点 = 1 元，点数不足时联系平台充值。</p>
        </div>
        <div class="price-grid">
          <article class="price-gift">
            <span>新公司注册即送</span><strong>100<small>点</small></strong>
            <p>注册到账，团队共享。</p>
            <RouterLink to="/auth/register">领取体验点数 ↗</RouterLink>
          </article>
          <article>
            <span>每个上线账号 / 每天</span><strong>1<small>点</small></strong>
            <p>当天多次打开，只扣一次。</p>
            <small>北京时间自然日</small>
          </article>
          <article>
            <span>文字翻译 / 员工席位</span><strong>0<small>元</small></strong>
            <p>把预算花在实际使用上。</p>
            <small>不额外按字符和席位收费</small>
          </article>
          <article>
            <span>公司累计缓冲期</span><strong>3<small>天</small></strong>
            <p>点数不足，也留出周转时间。</p>
            <small>累计使用，充值后不重置</small>
          </article>
        </div>
        <div class="price-calculator">
          <div>
            <b>先算一笔明白账。</b>
            <p>假设这些账号在选定天数内每天都上线</p>
          </div>
          <div class="calculator-fields">
            <label
              >上线账号<input
                v-model.number="accounts"
                type="number"
                min="1"
                max="500"
                aria-label="上线账号数量" /></label
            ><span>×</span
            ><label
              >使用天数<input
                v-model.number="days"
                type="number"
                min="1"
                max="365"
                aria-label="使用天数" /></label
            ><span>=</span
            ><output aria-live="polite"
              ><b>{{ cost.toLocaleString() }}</b> 点
              <small>约 {{ cost.toLocaleString() }} 元</small></output
            >
          </div>
        </div>
        <p class="price-footnote">
          未上线的日期不扣点。赠送 100 点可覆盖 {{ Math.floor(100 / count) }} 个完整使用日（每天
          {{ count }} 个账号）。第三方平台自身费用另计。
        </p>
      </section>

      <section id="faq" class="home-faq home-wrap">
        <div>
          <span class="home-eyebrow">04 / A FEW THINGS TO KNOW</span>
          <h2>你可能还想知道。</h2>
          <p>收费规则说清楚，使用才安心。</p>
          <RouterLink class="text-link" to="/account-center">联系平台 / 查看充值说明 ↗</RouterLink>
        </div>
        <div>
          <details v-for="([q, a], index) in faqs" :key="q" :open="index === 0">
            <summary>{{ q }}<span>+</span></summary>
            <p>{{ a }}</p>
          </details>
        </div>
      </section>

      <section class="home-cta home-wrap">
        <span class="home-eyebrow">YOUR NEXT CONVERSATION STARTS HERE.</span>
        <h2>下一句“你好”，<br />可以来自世界任何地方。</h2>
        <RouterLink class="home-button primary" to="/auth/register"
          >开始使用工单007 <span>↗</span></RouterLink
        >
        <p>新公司注册赠送 100 点 · 翻译免费</p>
        <span class="cta-symbol" aria-hidden="true">↗</span>
      </section>
    </main>
    <footer class="home-footer home-wrap">
      <RouterLink class="home-brand" to="/home"><span>007</span>工单007</RouterLink>
      <p>让每一段跨境沟通，有回应，也有记录。</p>
      <RouterLink to="/dashboard">管理后台 ↗</RouterLink
      ><small>© {{ new Date().getFullYear() }} 工单007</small>
    </footer>
  </div>
</template>
