/**
 * Discover appeal file refs on mahakim (commercial Casablanca, code 8221).
 */
import { chromium } from 'playwright';

const HOME_URL = 'https://mahakim.ma/#/';
const CODE = '8221';
const YEAR = '2018';
const START = 4900;
const END = 4960;
const MAX = 10;

async function tryOne(page, numero) {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
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
  for (let i = 0; i < (await opts.count()); i++) {
    const t = ((await opts.nth(i).textContent()) || '').replace(/\s+/g, ' ');
    if (t.includes('التجارية') && t.includes('البيضاء')) {
      await opts.nth(i).click();
      break;
    }
  }
  await page.getByRole('button', { name: 'بحث', exact: true }).first().click();
  await page.waitForTimeout(4000);
  const text = await page.evaluate(() => document.body.innerText);
  const found = !/لا (توجد|يوجد)|لم يتم العثور/i.test(text) && /بطاقة|رقم الملف/i.test(text);
  return found ? `${YEAR}/${CODE}/${numero}` : null;
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'ar-MA' });
const refs = [];

for (let n = START; n <= END && refs.length < MAX; n++) {
  const page = await ctx.newPage();
  try {
    const ref = await tryOne(page, String(n));
    if (ref) {
      refs.push(ref);
      console.log('FOUND', ref);
    }
  } catch (e) {
    console.log('ERR', n, e.message);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log('REFS_JSON', JSON.stringify(refs));
