import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildMobileNotificationDeepLink } from '@/lib/mobile-notifications';
import { resolveWebNotificationPath } from '@/lib/web-notification-links';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

/**
 * Every destination the server writes into a notification, one line per kind.
 *
 * The app opens a notification link only when its route is on the app's own
 * list, and does nothing with any other: no error, on either side. This suite
 * holds the server to the lines in the contract, and the mobile suite
 * (`ugc-mobile/__tests__/notification-deep-links.test.ts`) holds the app to
 * opening each of them. A link added here without its line fails this file; a
 * line added without its route fails that one.
 */
const deepLinks: Record<string, string> = mobileApiContract.endpoints.mobileNotifications.deepLinks;

const notifierSource = fs.readFileSync(path.resolve('src/lib/mobile-notifications.ts'), 'utf8');

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

describe('the links the server writes into notifications', () => {
  it('builds each kind as the contract has it', () => {
    expect({
      generation: buildMobileNotificationDeepLink({ kind: 'generation', generationId: 'generation-1' }),
      templateRun: buildMobileNotificationDeepLink({ kind: 'templateRun', runId: 'run-1' }),
      workflowCanvas: buildMobileNotificationDeepLink({ kind: 'workflowCanvas', canvasId: 'canvas-1' }),
      showcasePost: buildMobileNotificationDeepLink({ kind: 'showcasePost', postId: 'post-1' }),
      marketplaceResource: buildMobileNotificationDeepLink({ kind: 'marketplaceResource', resourceId: 'resource-1' }),
      creatorProfile: buildMobileNotificationDeepLink({ kind: 'creatorProfile', username: 'batman' }),
      notifications: buildMobileNotificationDeepLink({ kind: 'notifications' }),
    }).toEqual({
      generation: deepLinks.generation,
      templateRun: deepLinks.templateRun,
      workflowCanvas: deepLinks.workflowCanvas,
      showcasePost: deepLinks.showcasePost,
      marketplaceResource: deepLinks.marketplaceResource,
      creatorProfile: deepLinks.creatorProfile,
      notifications: deepLinks.notifications,
    });
  });

  it('has a contract line for every kind the builder takes', () => {
    const builder = /export function buildMobileNotificationDeepLink\(target:([\s\S]*?)\n\) \{/.exec(notifierSource);
    const kinds = Array.from(builder?.[1].matchAll(/kind: '([A-Za-z]+)'/g) ?? [], (match) => match[1]);

    // The scan is reading the builder it thinks it is.
    expect(kinds).toEqual(expect.arrayContaining(['generation', 'templateRun', 'notifications']));
    expect(kinds.filter((kind) => !(kind in deepLinks))).toEqual([]);
  });

  it('has a contract line for every link written out by hand', () => {
    const written = sourceFiles(path.resolve('src/lib')).flatMap((file) => (
      Array.from(fs.readFileSync(file, 'utf8').matchAll(/deepLink: '(\/[^']*)'/g), (match) => match[1])
    ));

    // The scan is reading the code it thinks it is.
    expect(written).toEqual(expect.arrayContaining(['/profile']));
    expect(written.filter((link) => !Object.values(deepLinks).includes(link))).toEqual([]);
  });

  it('keeps SQL-created referral notification links in the same mobile contract', () => {
    const sql = fs.readFileSync(path.resolve('supabase/migrations/20261007150522_referral_reward_notification_outbox.sql'), 'utf8');
    const link = /'(\/[^']+)', 'referral_reward', v_event\.reward_id/.exec(sql)?.[1];
    expect(link).toBe(deepLinks.invite);
  });

  it('opens each of them on the web as well', () => {
    // The web's Alerts page reads the same rows and turns each link into a web route.
    expect(Object.fromEntries(
      Object.entries(deepLinks).map(([kind, link]) => [kind, resolveWebNotificationPath(link)]),
    )).toEqual({
      generation: '/creations?generation=generation-1',
      templateRun: '/template-runs/run-1',
      workflowCanvas: '/create-workflow?canvas=canvas-1',
      showcasePost: '/showcase/post-1',
      marketplaceResource: '/marketplace/resource-1',
      creatorProfile: '/creators/batman',
      notifications: null,
      profile: '/profile',
      invite: '/invite',
    });
    // A run has its own page on the web, so its link needs no translation.
    expect(fs.existsSync(path.resolve('src/app/template-runs/[runId]/page.tsx'))).toBe(true);
  });

  it('sends a workflow run to the canvas on the web and to Alerts in the app', () => {
    // The app has no canvas and opens only the routes on its own list, so the
    // link is the Alerts route the app already opens, with the canvas on it.
    const link = buildMobileNotificationDeepLink({ kind: 'workflowCanvas', canvasId: 'a canvas/1' });

    expect(link.split('?')[0]).toBe(deepLinks.notifications);
    expect(resolveWebNotificationPath(link)).toBe('/create-workflow?canvas=a%20canvas%2F1');
    // The page at that address opens the canvas its `canvas` parameter names.
    expect(fs.readFileSync(path.resolve('src/app/create-workflow/page.tsx'), 'utf8')).toContain('resolvedSearchParams.canvas');
  });
});
