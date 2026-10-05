/** A failed maintenance pass can still have completed independent work. */
export class MobilePushMaintenanceError extends Error {
  constructor(cause: unknown, readonly summary: Record<string, unknown>) {
    super(cause instanceof Error ? cause.message : 'Push maintenance failed.', { cause });
    this.name = 'MobilePushMaintenanceError';
  }
}
