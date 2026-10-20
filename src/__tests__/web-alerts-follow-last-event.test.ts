import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

/**
 * The web Alerts page reads the same inbox as the app, so it follows the same
 * rule: an alert's age is its last event, the field the inbox is ordered by.
 * It printed the arrival time, so a grouped alert that had just moved to the
 * top on a new event still showed the age of its first one.
 */
const { ordering } = mobileApiContract.endpoints.mobileNotifications;
const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
// The page reads the inbox; its signed-in half, loaded on its own, draws the rows.
const alertsPage = read('src/app/notifications/page.tsx');
const alertsRows = read('src/app/notifications/SignedInAlerts.tsx');

describe("web Alerts follow each alert's last event", () => {
  it('prints the field the inbox is ordered by as the age of a row', () => {
    expect(ordering.by).toBe('updatedAt');
    expect(alertsRows.match(/formatNotificationTime\(notification\.\w+,/g)).toEqual([
      `formatNotificationTime(notification.${ordering.by},`,
    ]);
    expect(alertsPage).not.toContain('formatNotificationTime(');
  });

  // `web-alerts-page.test.tsx` draws the rows in the server's order across a
  // refresh and an older page; this holds the source to never re-order them.
  it('lists the alerts in the order the server sent them', () => {
    expect(ordering.direction).toBe('descending');
    expect(alertsPage).toContain('const newest: WebNotification[] = data.notifications || [];');
    expect(alertsPage).toContain('const older: WebNotification[] = data.notifications || [];');
    for (const source of [alertsPage, alertsRows]) {
      expect(source).not.toMatch(/\.(?:sort|toSorted|reverse|toReversed)\(/);
    }
  });
});
