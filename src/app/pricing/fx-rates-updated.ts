/**
 * When /pricing's exchange rates were read, for people: "16 Nov 2026, 5:32 am" in the reader's own
 * language and time zone, as Credit history says a time (`formatCreditHistoryTime`). `/api/fx`
 * sends an ISO 8601 stamp, "2026-11-16T00:02:31.000Z", or none for a provider stamp it cannot
 * read, and the page then draws no line (fx-rates-service.ts). It passed on the provider's RFC 2822
 * date, "Mon, 16 Nov 2026 00:02:31 +0000", until 2026-11-17, and the page showed that as it came
 * until the sweep of the same day. `Date.parse` reads both, so an answer the edge cached before the
 * route changed (an hour, and a day more while it revalidates) still reads.
 * Null for a stamp that cannot be read: the page then leaves the line out rather than show it raw.
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
