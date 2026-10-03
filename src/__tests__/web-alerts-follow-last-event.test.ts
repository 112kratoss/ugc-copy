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
const alertsPage = fs.readFileSync(path.resolve(process.cwd(), 'src/app/notifications/page.tsx'), 'utf8');

describe("web Alerts follow each alert's last event", () => {
  it('prints the field the inbox is ordered by as the age of a row', () => {
    expect(ordering.by).toBe('updatedAt');
    expect(alertsPage.match(/formatNotificationTime\(notification\.\w+,/g)).toEqual([
      `formatNotificationTime(notification.${ordering.by},`,
    ]);
  });

  it('lists the alerts in the order the server sent them', () => {
    expect(ordering.direction).toBe('descending');
    expect(alertsPage).toContain('setNotifications(data.notifications || []);');
    expect(alertsPage).not.toMatch(/\.(?:sort|toSorted|reverse|toReversed)\(/);
  });
});
