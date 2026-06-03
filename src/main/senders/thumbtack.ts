// Sends a reply on a Thumbtack pro-inbox thread via the operator's Chrome (CDP attach).
// Real composer DOM (verified):
//   textarea:  <textarea class="tp-textarea bn" placeholder="Type message">
//   send btn:  icon-only <button type="button"> with a paper-plane <svg>, hashed classes,
//              DISABLED until the textarea has content. No accessible name — so we locate
//              it structurally (first <button> following the textarea) and wait for enable.

import { chromium, BrowserContext } from 'playwright-core';

export async function sendThumbtackReply(cdpPort: number, threadUrl: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const ctx: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    try {
      await page.goto(threadUrl, { waitUntil: 'domcontentloaded' });

      const textarea = page.locator('textarea[placeholder="Type message" i]');
      await textarea.waitFor({ state: 'visible', timeout: 15_000 });
      await textarea.click();
      // Type so React's onChange fires and enables the send button.
      // (fill() can leave controlled inputs without an input event in some builds.)
      await textarea.fill('');
      await textarea.pressSequentially(text, { delay: 8 });

      // The send button is the first <button> after the textarea. It enables once there's text.
      const sendBtn = textarea.locator('xpath=following::button[1]');
      // Wait until it's no longer disabled (up to 5s).
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const disabled = await sendBtn.getAttribute('disabled').catch(() => null);
        const ariaDisabled = await sendBtn.getAttribute('aria-disabled').catch(() => null);
        if (disabled === null && ariaDisabled !== 'true') break;
        await page.waitForTimeout(200);
      }

      // Watch specifically for the send mutation (not the constant tracking GraphQL).
      const sendMutation = page.waitForResponse(
        async (r) => {
          if (!/app\.thumbtack\.com\/graphql/.test(r.url()) || r.request().method() !== 'POST' || !r.ok()) return false;
          const op = (() => { try { return (JSON.parse(r.request().postData() || '{}') as { operationName?: string }).operationName ?? ''; } catch { return ''; } })();
          return /send|message|reply|negotiation/i.test(op);
        },
        { timeout: 20_000 },
      ).catch(() => null);

      await sendBtn.click({ timeout: 5_000 }).catch(async () => {
        await textarea.press('Meta+Enter').catch(() => undefined);
      });

      // PRIMARY success signal: the composer actually empties. This only happens when
      // Thumbtack accepts the send — a tracking GraphQL call can't fake it.
      const cleared = await page.waitForFunction(() => {
        const t = document.querySelector('textarea[placeholder="Type message" i]') as HTMLTextAreaElement | null;
        return !!t && t.value.trim() === '';
      }, { timeout: 12_000 }).then(() => true).catch(() => false);

      const mutation = await sendMutation;

      if (!cleared && !mutation) {
        return { ok: false, error: 'Composer did not clear and no send mutation seen — message likely did NOT post.' };
      }
      // Cleared composer is the strong signal; mutation alone is a weaker fallback.
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
