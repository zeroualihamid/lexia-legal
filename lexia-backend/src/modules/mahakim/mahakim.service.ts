import { Injectable, Logger } from '@nestjs/common';
import { chromium, Browser, Page } from 'playwright';
import { CaseCategory, MahakimQuery,
  MahakimResult,
  MahakimTable,
} from './mahakim.types';

const HOME_URL = 'https://mahakim.ma/#/';
const NAV_TIMEOUT = 60_000;

/**
 * Headless scraper for the Moroccan justice portal (https://mahakim.ma),
 * "تتبع الملفات" (case tracking) service. Given a structured court-file
 * reference it fills the public lookup form and returns whatever the result
 * page exposes as a structured snapshot.
 *
 * The portal is a hash-routed Angular SPA with no CAPTCHA on this service.
 * The result DOM varies per case, so scraping is intentionally generic:
 * every table + any banner message + a capped text snapshot are captured so
 * the data is usable both in the UI and as chat context.
 */
@Injectable()
export class MahakimService {
  private readonly logger = new Logger(MahakimService.name);

  async fetchCase(query: MahakimQuery): Promise<MahakimResult> {
    let browser: Browser | null = null;
    const capturedAt = new Date().toISOString();
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
      const ctx = await browser.newContext({
        locale: 'ar-MA',
        viewport: { width: 1366, height: 950 },
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      });
      const page = await ctx.newPage();

      await this.runSearchOnPage(page, query);
      const result = await this.scrapeResult(page);
      return { ...result, query, capturedAt };
    } finally {
      if (browser) await browser.close().catch(() => undefined);
    }
  }

  /**
   * Lookup an appeal-format file reference, iterating court dropdown options
   * until a match is found (or exhausting the list).
   */
  async fetchCaseAuto(input: {
    fileNumber: string;
    fileCode: string;
    fileYear: string;
    courtName?: string;
    courtType?: 'appeal' | 'first_instance';
    category?: CaseCategory;
  }): Promise<MahakimResult> {
    let browser: Browser | null = null;
    const capturedAt = new Date().toISOString();
    const triedCourts: string[] = [];
    const courtType = input.courtType || 'appeal';
    const category = input.category || 'file';

    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
      const ctx = await browser.newContext({
        locale: 'ar-MA',
        viewport: { width: 1366, height: 950 },
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      });

      const probePage = await ctx.newPage();
      await this.openTrackingForm(probePage);
      await this.selectCategory(probePage, category);
      await this.fillFileReference(probePage, {
        courtType,
        courtName: input.courtName || '',
        fileNumber: input.fileNumber,
        fileCode: input.fileCode,
        fileYear: input.fileYear,
        category,
      });
      const courts = await this.listCourtOptions(probePage);
      await probePage.close().catch(() => undefined);

      const order = this.orderCourts(courts, input.courtName);
      if (!order.length) {
        return {
          found: false,
          message: 'لم يتم العثور على محاكم مطابقة بعد إدخال مرجع الملف',
          fields: {},
          tables: [],
          text: '',
          query: {
            courtType,
            courtName: input.courtName || '',
            fileNumber: input.fileNumber,
            fileCode: input.fileCode,
            fileYear: input.fileYear,
            category,
          },
          capturedAt,
          triedCourts,
        };
      }

      let lastResult: Omit<MahakimResult, 'query' | 'capturedAt'> | null = null;
      let winningQuery: MahakimQuery | null = null;

      for (const courtName of order) {
        triedCourts.push(courtName);
        const page = await ctx.newPage();
        const query: MahakimQuery = {
          courtType,
          courtName,
          fileNumber: input.fileNumber,
          fileCode: input.fileCode,
          fileYear: input.fileYear,
          category,
        };
        try {
          await this.runSearchOnPage(page, query);
          const result = await this.scrapeResult(page);
          lastResult = result;
          if (result.found) {
            winningQuery = query;
            await page.close().catch(() => undefined);
            break;
          }
        } finally {
          await page.close().catch(() => undefined);
        }
        await this.sleep(400);
      }

      const base = lastResult || {
        found: false,
        message: 'لم يتم العثور على نتيجة',
        fields: {},
        tables: [],
        text: '',
      };

      return {
        ...base,
        query:
          winningQuery ||
          ({
            courtType,
            courtName: input.courtName || order[0] || '',
            fileNumber: input.fileNumber,
            fileCode: input.fileCode,
            fileYear: input.fileYear,
            category,
          } as MahakimQuery),
        capturedAt,
        triedCourts,
      };
    } finally {
      if (browser) await browser.close().catch(() => undefined);
    }
  }

  /** Parse the "بطاقة الملف" label/value pairs from a mahakim result snapshot. */
  parseFileCard(text: string): Record<string, string> {
    const labels = [
      'المحكمة',
      'رقم الملف بالمحكمة',
      'الرقم الوطني للملف',
      'نوع الملف',
      'الموضوع',
      'تاريخ التسجيل',
      'آخر حكم/قرار',
      'رقم آخر حكم / القرار',
      'تاريخ آخر حكم / القرار',
      'المستشار / القاضي المقرر',
    ];
    const card: Record<string, string> = {};
    const lines = (text || '')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const label = labels.find((l) => line === l || line.startsWith(l));
      if (label && lines[i + 1] && !labels.includes(lines[i + 1])) {
        card[label] = lines[i + 1];
        i += 1;
      }
    }
    return card;
  }

  private async runSearchOnPage(page: Page, query: MahakimQuery): Promise<void> {
    await this.openTrackingForm(page);
    await this.selectCategory(page, query.category);
    await this.fillFileReference(page, query);
    await this.selectCourt(page, query);
    await this.submitSearch(page);
  }

  private orderCourts(courts: string[], preferred?: string): string[] {
    if (!preferred) return courts;
    const norm = (s: string) => s.replace(/\s+/g, '').trim();
    const target = norm(preferred);
    const match = courts.filter(
      (c) => norm(c) === target || norm(c).includes(target) || target.includes(norm(c)),
    );
    const rest = courts.filter((c) => !match.includes(c));
    return [...match, ...rest];
  }

  private async listCourtOptions(page: Page): Promise<string[]> {
    const dd = page.locator('.p-dropdown').first();
    if (!(await dd.count())) return [];

    await dd.click({ timeout: 8000 });
    await this.waitForCourtOptions(page);

    const opts = page.locator('.p-dropdown-items li');
    const count = await opts.count();
    const courts: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = ((await opts.nth(i).textContent()) || '').replace(/\s+/g, ' ').trim();
      if (t && !t.includes('لميتم')) courts.push(t);
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    return courts;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async openTrackingForm(page: Page): Promise<void> {
    await page.goto(HOME_URL, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(2500);
    // The "تتبع الملفات" entry navigates to the tracking service.
    const link = page.getByText('تتبع الملفات', { exact: false }).first();
    await link.click({ timeout: 15_000 });
    // Wait for the file-code field to appear (form is rendered).
    await page.waitForSelector('input[formcontrolname="mark"]', {
      timeout: 30_000,
    });
    await page.waitForTimeout(1500);
  }

  private async selectCategory(page: Page, category: string): Promise<void> {
    // The category tabs are plain buttons. 'file' is the default tab.
    const label = category === 'hearings' ? 'جدول الجلسات' : 'ملف/محضر/شكاية';
    try {
      const tab = page.getByRole('button', { name: label, exact: false }).first();
      if (await tab.count()) {
        await tab.click({ timeout: 5000 });
        await page.waitForTimeout(800);
      }
    } catch {
      /* default tab is fine */
    }
  }

  private async fillFileReference(page: Page, query: MahakimQuery): Promise<void> {
    // رقم الملف / رمز الملف / السنة — entering all three triggers the court list.
    const numero = page.locator('input[formcontrolname="numero"]');
    if (await numero.count()) {
      await numero.fill(query.fileNumber || '', { timeout: 10_000 });
    }
    const mark = page.locator('input[formcontrolname="mark"]');
    await mark.fill(query.fileCode, { timeout: 10_000 });
    const annee = page.locator('input[formcontrolname="annee"]');
    await annee.fill(query.fileYear, { timeout: 10_000 });
    await page.waitForTimeout(800);
  }

  private async selectCourt(page: Page, query: MahakimQuery): Promise<void> {
    if (query.courtType === 'first_instance') {
      // Tick "هل تريد البحث بالمحاكم الابتدائية" to reveal the first-instance field.
      const cb = page.locator('input[type="checkbox"]').first();
      if (await cb.count()) {
        await cb.check({ timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(800);
      }
    }

    // The court selector is a PrimeNG p-dropdown whose options auto-load from
    // the file number just entered. Open it, wait for options, pick the match.
    const dd = page.locator('.p-dropdown').first();
    if (!(await dd.count())) {
      this.logger.warn('Court dropdown not found; submitting without it');
      return;
    }
    await page.locator('#loader-wrapper').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => undefined);
    await dd.click({ timeout: 15000 });
    await this.waitForCourtOptions(page);
    await this.pickOption(page, query.courtName);

    // First-instance courts live in a dependent second dropdown (best-effort).
    if (query.courtType === 'first_instance') {
      const dd2 = page.locator('.p-dropdown').nth(1);
      if (await dd2.count()) {
        await dd2.click({ timeout: 5000 }).catch(() => undefined);
        await this.waitForCourtOptions(page);
        await this.pickOption(page, query.courtName, true);
      }
    }
  }

  private async waitForCourtOptions(page: Page): Promise<void> {
    for (let t = 0; t < 10; t++) {
      await page.waitForTimeout(800);
      const opts = page.locator('.p-dropdown-items li');
      const n = await opts.count();
      if (n > 0) {
        const first = ((await opts.first().textContent()) || '').replace(/\s+/g, '');
        if (n > 1 || !first.includes('لميتم')) return;
      }
    }
  }

  /** Click the dropdown option that best matches courtName (whitespace-insensitive). */
  private async pickOption(
    page: Page,
    courtName: string,
    allowFirstFallback = false,
  ): Promise<void> {
    const norm = (s: string | null) => (s || '').replace(/\s+/g, '').trim();
    const target = norm(courtName);
    const opts = page.locator('.p-dropdown-items li');
    const count = await opts.count();
    let matchIdx = -1;
    let firstReal = -1;
    for (let i = 0; i < count; i++) {
      const t = norm(await opts.nth(i).textContent());
      if (!t || t.includes('لميتم')) continue;
      if (firstReal === -1) firstReal = i;
      if (target && (t === target || t.includes(target) || target.includes(t))) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx === -1 && target.includes('التجارية') && target.includes('البيضاء')) {
      for (let i = 0; i < count; i++) {
        const t = norm(await opts.nth(i).textContent());
        if (t.includes('التجارية') && t.includes('البيضاء')) {
          matchIdx = i;
          break;
        }
      }
    }
    const idx = matchIdx !== -1 ? matchIdx : allowFirstFallback ? firstReal : -1;
    if (idx >= 0) {
      await opts.nth(idx).click({ timeout: 4000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    } else {
      this.logger.warn(`No matching court option for "${courtName}"`);
    }
  }

  private async submitSearch(page: Page): Promise<void> {
    const searchBtn = page.getByRole('button', { name: 'بحث', exact: true }).first();
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined),
      searchBtn.click({ timeout: 10_000 }),
    ]);
    // Give Angular time to render the result section.
    await page.waitForTimeout(4000);
  }

  private async scrapeResult(page: Page): Promise<Omit<MahakimResult, 'query' | 'capturedAt'>> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) =>
        (s || '').replace(/\s+/g, ' ').trim();

      // Tables anywhere in the main content (skip the top nav/header).
      const tables: MahakimTable[] = [];
      document.querySelectorAll('table').forEach((tbl) => {
        const headers = Array.from(tbl.querySelectorAll('thead th, thead td')).map(
          (th) => clean(th.textContent),
        );
        const rows: string[][] = [];
        const bodyRows = tbl.querySelectorAll('tbody tr');
        const rowSource = bodyRows.length
          ? bodyRows
          : tbl.querySelectorAll('tr');
        rowSource.forEach((tr) => {
          const cells = Array.from(tr.querySelectorAll('td')).map((td) =>
            clean(td.textContent),
          );
          if (cells.some((c) => c.length)) rows.push(cells);
        });
        if (rows.length || headers.length) {
          tables.push({
            caption: clean(tbl.querySelector('caption')?.textContent) || null,
            headers,
            rows,
          });
        }
      });

      // Label/value pairs from definition-list-like structures.
      const fields: Record<string, string> = {};
      document
        .querySelectorAll('.row, .form-group, .info-row, dl, .field')
        .forEach((el) => {
          const label = clean(
            el.querySelector('label, dt, .label, strong, b')?.textContent,
          );
          const value = clean(
            el.querySelector('.value, dd, span, p')?.textContent,
          );
          if (label && value && label !== value && label.length < 60) {
            fields[label] = value;
          }
        });

      // Banner / no-result message. Take a tight window around the keyword so
      // we don't capture the surrounding navigation chrome.
      const bodyText = clean(document.body.innerText);
      const noResult =
        /لا (توجد|يوجد)|لم يتم العثور|aucun|pas de résultat|غير موجود/i;
      let message: string | null = null;
      const km = bodyText.match(noResult);
      if (km && km.index !== undefined) {
        message = clean(bodyText.slice(km.index, km.index + 120));
      }

      const hasNoResult = noResult.test(bodyText);
      const found =
        (tables.some((t) => t.rows.length > 0) ||
          Object.keys(fields).length > 0) &&
        !hasNoResult;

      return {
        found,
        message,
        fields,
        tables,
        text: bodyText.slice(0, 8000),
      } as Omit<MahakimResult, 'query' | 'capturedAt'>;
    });
  }
}
