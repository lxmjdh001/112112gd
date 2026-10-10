import assert from "node:assert/strict";

// Poll resolved IPC states explicitly rather than testing a pending Promise.
export async function waitClientState(page, predicate, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let state;
    try {
      state = await page.evaluate(() => window.gongdan?.state());
    } catch (error) {
      // firstWindow can resolve before the initial renderer navigation finishes.
      // Retry that navigation race, but surface real IPC and application errors.
      if (page.isClosed() || !String(error).includes("Execution context was destroyed"))
        throw error;
    }
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Client state did not reach the expected condition");
}
