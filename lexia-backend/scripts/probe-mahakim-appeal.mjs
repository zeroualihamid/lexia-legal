/**
 * Quick probe: find mahakim appeal hits for commercial court code 8221.
 * Usage: node scripts/probe-mahakim-appeal.mjs
 */
import { chromium } from 'playwright';

const HOME_URL = 'https://mahakim.ma/#/';
const COURT = 'محكمة الاستئناf التجارية بالدار البيضاء';
const CODE = '8221';
const YEAR = '2018';
const NUMBERS = ['4930', '4931', '4932', '4933', '4934', '4935'];

async function tryOne(page, numero) {
  await page.goto(HOME_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.getByText('تتبع الملفات', { exact: false }).first().click({ timeout: 15000 });
  await page.waitForSelector('input[formcontrolname="mark"]', { timeout: 30000 });
  await page.locator('input[formcontrolname="numero"]').fill(numero);
  await page.locator('input[formcontrolname="mark"]').fill(CODE);
  await page.locator('input[formcontrolname="annee"]').fill(YEAR);
  await page.waitForTimeout(1000);
  const dd = page.locator('.p-dropdown').first();
  await dd.click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  const opts = page.locator('.p-dropdown-items li');
  for (let i = 0; i < await opts.count(); i++) {
    const t = ((await opts.nth(i).textContent()) || '').replace(/\s+/g, ' ');
    if (t.includes('التجارية') && t.includes('البيضاء')) {
      await opts.nth(i).click();
      break;
    }
  }
  await page.getByRole('button', { name: 'بحث', exact: true }).first().click();
  await page.waitForTimeout(4000);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  const found = !/لا (توجد|يوجد)|لم يتم العثور/i.test(text) && text.includes('بطاقة');
  return { numero, found, snippet: text.slice(0, 200) };
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'ar-MA' });
for (const n of NUMBERS) {
  const page = await ctx.newPage();
  try {
    const r = await tryOne(page, n);
    console.log(JSON.stringify(r));
  } catch (e) {
    console.log(JSON.stringify({ numero: n, found: false, error: e.message }));
  } finally {
    await page.close();
  }
}
await browser.close();
