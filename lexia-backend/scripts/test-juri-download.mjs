import { chromium } from 'playwright';

const BASE = 'https://juriscassation.cspj.ma';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    locale: 'ar-MA',
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(() => {
    const orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (/^\d{4,9}$/.test(String(text))) {
        window.__lexiaCaptcha = String(text);
      }
      return orig.call(this, text, x, y, maxWidth);
    };
  });

  const page = await context.newPage();
  await page.goto(`${BASE}/ar/Decisions/RechercheDecisions`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  const roomValues = await page
    .locator('#room-selection option')
    .evaluateAll((opts) => opts.map((o) => o.value).filter(Boolean));
  await page.selectOption('#room-selection', roomValues);
  await page.fill('#Sujet', 'تأمين');
  await page.locator('form[action*="RechercheDecisionsRes"] button[type="submit"]').click();
  await page.waitForSelector('#myid tbody tr', { timeout: 60000 });

  const firstBtn = page.locator('#myid tbody tr .show-modal-btn').first();
  await firstBtn.click();
  await page.waitForSelector('#staticBackdrop.show, #staticBackdrop.modal.show', {
    timeout: 10000,
  });
  await page.waitForTimeout(500);
  const code = await page.evaluate(() => window.__lexiaCaptcha);
  console.log('captcha', code);
  await page.fill('#input_code', code || '');
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('.view_doc').click(),
  ]);
  await popup.waitForLoadState('domcontentloaded', { timeout: 30000 });
  console.log('popup url', popup.url());
  const resp = await popup.request.get(popup.url());
  console.log('content-type', resp.headers()['content-type'], 'size', (await resp.body()).length);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
