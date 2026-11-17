/**
 * When /pricing's exchange rates were read, for people: "16 Nov 2026, 5:32 am" in the reader's own
 * language and time zone, as Credit history says a time (`formatCreditHistoryTime`). `/api/fx`
 * passes on the provider's stamp, an RFC 2822 date such as "Mon, 16 Nov 2026 00:02:31 +0000", and
 * the page showed it as it came until the sweep of 2026-11-17. Null for a stamp that cannot be
 * read: the page then leaves the line out rather than show it raw.
 *
 * Only the browser formats it. The page draws the line once its script has read the rates, so the
 * server, which knows neither the reader's language nor their zone, never draws it, and hydration
 * has no date to disagree on.
 */
export function formatFxRatesUpdatedAt(
  value: string,
  { locale, timeZone }: { locale?: string; timeZone?: string } = {},
): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;

  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(timestamp);
}
