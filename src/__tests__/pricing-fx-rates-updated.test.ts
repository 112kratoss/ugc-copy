import { describe, expect, it } from 'vitest';

import { formatFxRatesUpdatedAt } from '@/app/pricing/fx-rates-updated';

// What /api/fx sends: open.er-api.com's `time_last_update_utc`, or, without one it can read, the
// time it read the rates, in ISO 8601 (fx-rates-service.ts).
const ROUTE_STAMP = '2026-11-16T00:02:31.000Z';
// What it passed on until 2026-11-17, the provider's RFC 2822 date as it came, which the page
// showed raw until the sweep of that day. An answer the edge cached before the change still holds it.
const PROVIDER_STAMP = 'Mon, 16 Nov 2026 00:02:31 +0000';

/** Some ICU versions put a narrow no-break space before AM and PM; a reader sees a space. */
const spaced = (text: string | null) => text?.replace(/ /g, ' ');

describe("/pricing's line on when the rates were read", () => {
  it("says the route's stamp in the reader's language and time zone, as Credit history says a time", () => {
    expect(spaced(formatFxRatesUpdatedAt(ROUTE_STAMP, { locale: 'en-IN', timeZone: 'Asia/Kolkata' })))
      .toBe('16 Nov 2026, 5:32 am');
    expect(spaced(formatFxRatesUpdatedAt(ROUTE_STAMP, { locale: 'en-US', timeZone: 'America/New_York' })))
      .toBe('Nov 15, 2026, 7:02 PM');
    expect(spaced(formatFxRatesUpdatedAt(ROUTE_STAMP, { locale: 'en-GB', timeZone: 'UTC' })))
      .toBe('16 Nov 2026, 00:02');
  });

  it('reads the RFC 2822 stamps the route passed on before, from an answer cached then', () => {
    expect(spaced(formatFxRatesUpdatedAt(PROVIDER_STAMP, { locale: 'en-IN', timeZone: 'Asia/Kolkata' })))
      .toBe('16 Nov 2026, 5:32 am');
    // The time it read the rates, which it wrote with `toUTCString` when the provider sent none.
    expect(spaced(formatFxRatesUpdatedAt('Mon, 16 Nov 2026 00:02:31 GMT', { locale: 'en-IN', timeZone: 'Asia/Kolkata' })))
      .toBe('16 Nov 2026, 5:32 am');
  });

  it('says nothing for a stamp it cannot read, rather than show it raw', () => {
    expect(formatFxRatesUpdatedAt('sometime yesterday')).toBeNull();
    expect(formatFxRatesUpdatedAt('')).toBeNull();
  });
});
