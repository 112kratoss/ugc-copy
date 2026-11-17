import { describe, expect, it } from 'vitest';

import { formatFxRatesUpdatedAt } from '@/app/pricing/fx-rates-updated';

// What /api/fx passes on: open.er-api.com's `time_last_update_utc`, or, without one, the time it
// read the rates (`toUTCString`). The page showed it as it came until the sweep of 2026-11-17.
const PROVIDER_STAMP = 'Mon, 16 Nov 2026 00:02:31 +0000';

/** Some ICU versions put a narrow no-break space before AM and PM; a reader sees a space. */
const spaced = (text: string | null) => text?.replace(/ /g, ' ');

describe("/pricing's line on when the rates were read", () => {
  it("says the provider's stamp in the reader's language and time zone, as Credit history says a time", () => {
    expect(spaced(formatFxRatesUpdatedAt(PROVIDER_STAMP, { locale: 'en-IN', timeZone: 'Asia/Kolkata' })))
      .toBe('16 Nov 2026, 5:32 am');
    expect(spaced(formatFxRatesUpdatedAt(PROVIDER_STAMP, { locale: 'en-US', timeZone: 'America/New_York' })))
      .toBe('Nov 15, 2026, 7:02 PM');
    expect(spaced(formatFxRatesUpdatedAt(PROVIDER_STAMP, { locale: 'en-GB', timeZone: 'UTC' })))
      .toBe('16 Nov 2026, 00:02');
  });

  it('reads the stamp the route writes itself when the provider sends none', () => {
    expect(spaced(formatFxRatesUpdatedAt('Mon, 16 Nov 2026 00:02:31 GMT', { locale: 'en-IN', timeZone: 'Asia/Kolkata' })))
      .toBe('16 Nov 2026, 5:32 am');
  });

  it('says nothing for a stamp it cannot read, rather than show it raw', () => {
    expect(formatFxRatesUpdatedAt('sometime yesterday')).toBeNull();
    expect(formatFxRatesUpdatedAt('')).toBeNull();
  });
});
