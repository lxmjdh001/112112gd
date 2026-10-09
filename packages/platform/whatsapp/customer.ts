// Read only the peer portion of visible native message IDs. Never infer identity
// from a display name or the participant segment of a group message.
export function customerFromMessageIds(ids: readonly string[]): string | null {
  const peers = new Set<string>();
  for (const id of ids) {
    const m = /^(?:true|false)_([^_]+)_/.exec(id);
    if (!m) continue;
    const peer = m[1]!;
    if (peer.endsWith("@g.us") || peer.endsWith("@broadcast") || peer.endsWith("@newsletter"))
      return null;
    const phone = /^([1-9][0-9]{6,14})(?::[0-9]+)?@(?:s\.whatsapp\.net|c\.us)$/.exec(peer);
    const lid = /^([0-9]{5,30})@lid$/.exec(peer);
    if (phone) peers.add(phone[1]!);
    else if (lid) peers.add(lid[1] + "@lid");
    else return null;
  }
  return peers.size === 1 ? [...peers][0]! : null;
}
export function currentWhatsAppCustomer(doc: Pick<Document, "querySelector">): string | null {
  const main = doc.querySelector("#main");
  if (!main) return null;
  return customerFromMessageIds(
    [...main.querySelectorAll("[data-id]")]
      .slice(-200)
      .map((el) => el.getAttribute("data-id") || ""),
  );
}
