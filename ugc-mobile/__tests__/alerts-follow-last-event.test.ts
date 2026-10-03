import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

/**
 * An alert's age and place follow its last event: its arrival, or the latest
 * event grouped into it. The server sends that time in the field the contract
 * names and lists the alerts by it, and the server suite holds it to that.
 * This suite holds the Alerts screen to printing the same field and to leaving
 * the order as sent.
 *
 * The age used to change when an alert was read: the field carried the time of
 * the last write to the alert's row, and reading it is a write.
 */
const { ordering } = mobileApiContract.endpoints.mobileNotifications;
const alertsScreen = readFileSync(path.resolve(__dirname, '..', 'app/(tabs)/studio.tsx'), 'utf8');

describe("Alerts follow each alert's last event", () => {
  it('prints the field the inbox is ordered by as the age of a row', () => {
    expect(ordering.by).toBe('updatedAt');

    // The age on screen and the age VoiceOver reads.
    expect(alertsScreen.match(/formatRelativeTime\(notification\.\w+\)/g)).toEqual([
      `formatRelativeTime(notification.${ordering.by})`,
      `formatRelativeTime(notification.${ordering.by})`,
    ]);
  });

  it('lists the alerts in the order the server sent them', () => {
    expect(ordering.direction).toBe('descending');
    expect(alertsScreen).toContain('const notifications = notificationsQuery.data?.notifications ?? [];');
    expect(alertsScreen).toContain('{notifications.map((notification) => (');
    expect(alertsScreen).not.toMatch(/\.(?:sort|toSorted|reverse|toReversed)\(/);
  });
});
