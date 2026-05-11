export type SupportedCurrency = 'INR' | 'USD' | 'EUR' | 'GBP' | 'AUD' | 'CAD' | 'SGD';

const EUROZONE_REGIONS = new Set([
  'AT',
  'BE',
  'CY',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PT',
  'SK',
  'SI',
  'ES',
]);

function inferRegion(locale: string) {
  try {
    const parsed = new Intl.Locale(locale);
    if (parsed.region) {
      return parsed.region.toUpperCase();
    }
  } catch {
    // Ignore invalid locale strings; fall back to regex parsing.
  }

  const match = locale.match(/-([A-Za-z]{2})\b/);
  return match ? match[1].toUpperCase() : null;
}

export function inferCurrencyFromCountry(countryCode?: string | null): SupportedCurrency | null {
  const normalizedCountryCode = countryCode?.trim().toUpperCase();
  if (!normalizedCountryCode) {
    return null;
  }

  switch (normalizedCountryCode) {
    case 'IN':
      return 'INR';
    case 'GB':
      return 'GBP';
    case 'US':
      return 'USD';
    case 'AU':
      return 'AUD';
    case 'CA':
      return 'CAD';
    case 'SG':
      return 'SGD';
    default:
      return EUROZONE_REGIONS.has(normalizedCountryCode) ? 'EUR' : null;
  }
}

export function inferCurrencyFromNavigator(languages: string[]): SupportedCurrency {
  for (const language of languages) {
    const region = inferRegion(language);
    if (!region) {
      continue;
    }

    const currency = inferCurrencyFromCountry(region);
    if (currency) {
      return currency;
    }
  }

  return 'USD';
}

export function convertFromInr(
  amountInr: number,
  currency: SupportedCurrency,
  rates: Record<string, number>
): number {
  if (currency === 'INR') {
    return amountInr;
  }

  const rate = rates[currency];
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    return Number.NaN;
  }

  return amountInr * rate;
}

export function convertFromUsd(
  amountUsd: number,
  currency: SupportedCurrency,
  inrRates: Record<string, number>
): number {
  if (currency === 'USD') {
    return amountUsd;
  }

  const usdPerInr = inrRates.USD;
  if (typeof usdPerInr !== 'number' || !Number.isFinite(usdPerInr)) {
    return Number.NaN;
  }

  if (currency === 'INR') {
    return amountUsd / usdPerInr;
  }

  const currencyPerInr = inrRates[currency];
  if (typeof currencyPerInr !== 'number' || !Number.isFinite(currencyPerInr)) {
    return Number.NaN;
  }

  return amountUsd * (currencyPerInr / usdPerInr);
}

export function formatMoney(amount: number, currency: SupportedCurrency, locale?: string): string {
  const fractionDigits = currency === 'INR' ? 0 : 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}
