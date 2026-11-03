/**
 * Intl formatters, built once for each locale and set of options and kept.
 *
 * Building one is slow on Hermes, whose Intl calls into the platform's ICU:
 * `formatRelativeTime` built a `DateTimeFormat` for every row older than five
 * weeks, about 40 ms of the Alerts list's first render (device sweep, Pixel 9a
 * emulator, dev build, 2026-11-03). A formatter keeps nothing from one call to
 * the next, so a kept one formats exactly as a new one would. It does take the
 * device's time zone when it is built, so a zone changed while the app runs
 * reaches it only after a relaunch.
 *
 * Keyed by the options as written: call sites pass literal objects, whose
 * properties keep their order.
 */
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function formatKey(locale: string, options: Intl.DateTimeFormatOptions | Intl.NumberFormatOptions) {
  return `${locale}|${JSON.stringify(options)}`;
}

export function cachedDateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = formatKey(locale, options);
  let format = dateTimeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateTimeFormats.set(key, format);
  }
  return format;
}

export function cachedNumberFormat(locale: string, options: Intl.NumberFormatOptions) {
  const key = formatKey(locale, options);
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}
