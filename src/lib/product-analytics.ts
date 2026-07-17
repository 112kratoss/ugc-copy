'use client';

export type ProductAnalyticsValue = string | number | boolean | null | undefined;

type AnalyticsWindow = Window & {
  gtag?: (command: 'event', eventName: string, parameters?: Record<string, ProductAnalyticsValue>) => void;
};

/**
 * Sends privacy-safe product events to the configured analytics provider while
 * also exposing a local browser event for diagnostics and automated checks.
 */
export function trackProductEvent(
  eventName: string,
  parameters: Record<string, ProductAnalyticsValue> = {}
): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent('magicbooklet:product-event', {
    detail: { eventName, parameters },
  }));
  (window as AnalyticsWindow).gtag?.('event', eventName, parameters);
}
