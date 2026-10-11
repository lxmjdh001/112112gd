/** Homepage identity uses the serving origin, so local URLs never enter a production build. */
export function updatePageMetadata(isHome: boolean) {
  const robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (robots) robots.content = isHome ? "index,follow" : "noindex,follow";
  for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) {
    const title = document.querySelector<HTMLMetaElement>(selector);
    if (title) title.content = document.title;
  }

  document.querySelector("#site-canonical")?.remove();
  document.querySelector("#site-identity")?.remove();
  document.querySelector('meta[property="og:url"]')?.remove();
  if (!isHome) return;

  const url = new URL(import.meta.env.BASE_URL, window.location.origin).href;
  const canonical = document.createElement("link");
  canonical.id = "site-canonical";
  canonical.rel = "canonical";
  canonical.href = url;
  const ogUrl = document.createElement("meta");
  ogUrl.setAttribute("property", "og:url");
  ogUrl.content = url;
  const identity = document.createElement("script");
  identity.id = "site-identity";
  identity.type = "application/ld+json";
  identity.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "D1 工单",
    alternateName: ["D1scrm", "D1 Scrm"],
    url,
    inLanguage: "zh-CN",
  });
  document.head.append(canonical, ogUrl, identity);
}
