import { expect, test } from '@playwright/test';

/**
 * /pricing says when its exchange rates were read. It said it in the provider's own words, an
 * RFC 2822 stamp under the currency picker: "Updated Mon, 16 Nov 2026 00:02:31 +0000" (live sweep,
 * 2026-11-17). It now says it for people, in the reader's language and time zone.
 *
 * The line comes only once the page's script has read the rates (`/api/fx`), so the server's HTML,
 * which knows neither the reader's language nor their zone, never holds it, and hydration has
 * nothing to disagree on: each run also fails on any hydration error.
 */

const COLD_PAGE = { timeout: 45_000 };
const FX = {
  base: 'INR',
  // As open.er-api.com sends `time_last_update_utc`, which /api/fx passes on as it comes.
  updatedAt: 'Mon, 16 Nov 2026 00:02:31 +0000',
  rates: { USD: 0.012, EUR: 0.011, GBP: 0.0095, AUD: 0.018, CAD: 0.016, SGD: 0.016 },
};

// As Credit history says a time: the date and the time, each in the reader's own way.
const READERS = [
  { locale: 'en-IN', timezoneId: 'Asia/Kolkata', line: 'Rates updated 16 Nov 2026, 5:32 am' },
  { locale: 'en-US', timezoneId: 'America/New_York', line: 'Rates updated Nov 15, 2026, 7:02 PM' },
] as const;

for (const reader of READERS) {
  test.describe(`a reader in ${reader.timezoneId}`, () => {
    test.use({ locale: reader.locale, timezoneId: reader.timezoneId });

    test(`/pricing says when the rates were read in the reader's own date and time: "${reader.line}"`, async ({ page }) => {
      test.setTimeout(120_000);
      const hydrationErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error' && /hydrat|did not match|didn't match/i.test(message.text())) {
          hydrationErrors.push(message.text());
        }
      });
      page.on('pageerror', (error) => {
        if (/hydrat/i.test(error.message)) hydrationErrors.push(error.message);
      });
      await page.route('**/api/fx', (route) => route.fulfill({ json: FX }));

      await page.goto('/pricing', COLD_PAGE);

      await expect(page.getByText(reader.line, { exact: true })).toBeVisible(COLD_PAGE);
      await expect(page.getByText(/\+0000|00:02:31/)).toHaveCount(0);
      expect(hydrationErrors).toEqual([]);
    });
  });
}
