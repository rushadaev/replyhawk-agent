// Sends a reply to a Yelp lead via the operator's Chrome (CDP attach).
// Ported from YELP-devtools/send-reply.mjs — handles both the inline composer and
// the "Need more information → Ask a question via message" new-lead modal gate.

import { chromium, BrowserContext } from 'playwright-core';

export async function sendYelpReply(cdpPort: number, leadUrl: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const ctx: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    try {
      await page.goto(leadUrl, { waitUntil: 'domcontentloaded' });

      const inlineTextarea = page.locator('textarea[name="message"]');
      const inlineSendBtn = page.locator('button[aria-label="Send message"]');
      const modalTextarea = page.locator('textarea[placeholder*="Address the customer" i]');
      const modalSendBtn = page.getByRole('button', { name: 'Send', exact: true });

      let textarea = inlineTextarea;
      let sendBtn = inlineSendBtn;

      const inlineVisible = await inlineTextarea.isVisible().catch(() => false);
      if (!inlineVisible) {
        // New-lead gate: Need more information → Ask a question via message → Next
        const needMore = page.getByRole('button', { name: /need more information/i });
        await needMore.waitFor({ state: 'visible', timeout: 10_000 });
        await needMore.click();
        const askOption = page.getByText(/ask a question via message/i);
        await askOption.waitFor({ state: 'visible', timeout: 10_000 });
        await askOption.click();
        const nextBtn = page.getByRole('button', { name: /^next$/i });
        await nextBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await nextBtn.click();
        textarea = modalTextarea;
        sendBtn = modalSendBtn;
      }

      await textarea.waitFor({ state: 'visible', timeout: 15_000 });
      await textarea.click();
      await textarea.fill(text);

      const sendResponse = page.waitForResponse(
        (r) => /graphql|leads|messages|conversation/i.test(r.url()) && r.request().method() === 'POST' && r.ok(),
        { timeout: 20_000 },
      ).catch(() => null);

      await sendBtn.click();

      // Yelp quality-review intercept: "Edit your response / Send anyway"
      const sendAnyway = page.getByRole('button', { name: /send anyway/i });
      try {
        await sendAnyway.waitFor({ state: 'visible', timeout: 3_000 });
        await sendAnyway.click();
      } catch { /* no intercept */ }

      const resp = await sendResponse;
      if (!resp) return { ok: false, error: 'No successful POST after Send — reply may not have gone through.' };
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
