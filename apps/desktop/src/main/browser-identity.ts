// Keep the actual Chromium/OS versions; remove only application product tokens
// which cause the official Web app to classify this Chromium view as unsupported.
export function chromiumUserAgent(value: string, applicationName: string): string {
  const product = applicationName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`(?:Electron|${product})/\\S+\\s?`, "g"), "");
}
