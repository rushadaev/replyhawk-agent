// Sends a reply on a Thumbtack pro-inbox thread via the operator's Chrome (CDP attach).
// Thumbtack's composer is a textarea (or contenteditable) at the bottom of the messenger;
// sending fires a GraphQL mutation we wait on to confirm.

import { chromium, BrowserContext } from 'playwright-core';

export async function sendThumbtackReply(cdpPort: number, threadUrl: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`);
    const ctx: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    try {
      await page.goto(threadUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500); // let the messenger hydrate

      // The composer is either a <textarea> or a contenteditable div. Try textarea first.
      const textarea = page.locator('textarea').filter({ hasNot: page.locator('[readonly]') }).last();
      const editable = page.locator('[contenteditable="true"]').last();

      let usedEditable = false;
      if (await textarea.isVisible().catch(() => false)) {
        await textarea.click();
        await textarea.fill(text);
      } else if (await editable.isVisible().catch(() => false)) {
        await editable.click();
        await editable.fill(text).catch(async () => {
          // contenteditable sometimes ignores fill — type instead
          await page.keyboard.insertText(text);
        });
        usedEditable = true;
      } else {
        return { ok: false, error: 'Could not find the Thumbtack message composer.' };
      }

      // Wait for the send mutation to confirm the message posted.
      const sendResponse = page.waitForResponse(
        (r) => /app\.thumbtack\.com\/graphql/.test(r.url()) && r.request().method() === 'POST' && r.ok(),
        { timeout: 20_000 },
      ).catch(() => null);

      // Click the Send button. Thumbtack labels it "Send".
      const sendBtn = page.getByRole('button', { name: /^send$/i }).last();
      if (await sendBtn.isVisible().catch(() => false)) {
        await sendBtn.click();
      } else {
        // Fallback: Enter sends in many composers
        await page.keyboard.press(usedEditable ? 'Enter' : 'Enter');
      }

      const resp = await sendResponse;
      if (!resp) return { ok: false, error: 'No GraphQL confirmation after Send — message may not have posted.' };
      return { ok: true };
    } finally {
      await page.close().catch(() => undefined);
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
