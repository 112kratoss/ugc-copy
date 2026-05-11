import { describe, expect, it } from 'vitest';

import {
  convertFromInr,
  convertFromUsd,
  inferCurrencyFromCountry,
  inferCurrencyFromNavigator,
} from '@/lib/currency';

describe('currency helpers', () => {
  describe('inferCurrencyFromCountry', () => {
    it('maps India country codes to INR', () => {
      expect(inferCurrencyFromCountry('IN')).toBe('INR');
    });

    it('maps US country codes to USD', () => {
      expect(inferCurrencyFromCountry('US')).toBe('USD');
    });

    it('maps UK country codes to GBP', () => {
      expect(inferCurrencyFromCountry('GB')).toBe('GBP');
    });

    it('maps Eurozone country codes to EUR', () => {
      expect(inferCurrencyFromCountry('DE')).toBe('EUR');
      expect(inferCurrencyFromCountry('FR')).toBe('EUR');
    });

    it('returns null for unknown or missing country codes', () => {
      expect(inferCurrencyFromCountry('BR')).toBeNull();
      expect(inferCurrencyFromCountry(null)).toBeNull();
      expect(inferCurrencyFromCountry()).toBeNull();
    });
  });

  describe('inferCurrencyFromNavigator', () => {
    it('maps India locales to INR', () => {
      expect(inferCurrencyFromNavigator(['en-IN'])).toBe('INR');
    });

    it('maps US locales to USD', () => {
      expect(inferCurrencyFromNavigator(['en-US'])).toBe('USD');
    });

    it('maps UK locales to GBP', () => {
      expect(inferCurrencyFromNavigator(['en-GB'])).toBe('GBP');
    });

    it('maps Eurozone locales to EUR', () => {
      expect(inferCurrencyFromNavigator(['fr-FR'])).toBe('EUR');
    });

    it('falls back to USD when region cannot be inferred', () => {
      expect(inferCurrencyFromNavigator(['en'])).toBe('USD');
    });
  });

  describe('convertFromInr', () => {
    it('returns the input amount for INR', () => {
      expect(convertFromInr(415, 'INR', { USD: 0.012 })).toBe(415);
    });

    it('converts INR into the selected currency using the provided rate', () => {
      expect(convertFromInr(100, 'USD', { USD: 0.012 })).toBeCloseTo(1.2);
    });

    it('returns NaN when the selected currency rate is missing', () => {
      expect(Number.isNaN(convertFromInr(100, 'EUR', { USD: 0.012 }))).toBe(true);
    });
  });

  describe('convertFromUsd', () => {
    it('returns the input amount for USD', () => {
      expect(convertFromUsd(5, 'USD', { USD: 0.012, EUR: 0.011 })).toBe(5);
    });

    it('converts USD to another currency using INR cross rates', () => {
      // 1 INR = 0.01 USD and 0.02 EUR => 1 USD = 2 EUR
      expect(convertFromUsd(5, 'EUR', { USD: 0.01, EUR: 0.02 })).toBeCloseTo(10);
    });

    it('returns NaN when USD rate is missing', () => {
      expect(Number.isNaN(convertFromUsd(5, 'EUR', { EUR: 0.02 }))).toBe(true);
    });

    it('returns NaN when target rate is missing', () => {
      expect(Number.isNaN(convertFromUsd(5, 'GBP', { USD: 0.01 }))).toBe(true);
    });
  });
});
