// @vitest-environment node
import { describe, expect, it } from 'vitest';

// `src/instrumentation.ts` installs stand-in process handlers until the SDK loads
// and then steps aside for the SDK's own. If an SDK upgrade dropped either default
// integration, nothing would report rejections or uncaught exceptions once the
// stand-ins had stepped aside: this pins them on the real SDK, not a mock.
describe('the server SDK the stand-ins hand over to', () => {
  it('installs its own rejection and uncaught-exception handlers by default', async () => {
    const Sentry = await import('@sentry/nextjs');
    const names = Sentry.getDefaultIntegrations({}).map((integration) => integration.name);
    expect(names).toEqual(expect.arrayContaining(['OnUnhandledRejection', 'OnUncaughtException']));
  });
});
