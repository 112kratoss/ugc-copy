import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..');
const patchFile = 'expo-notifications+55.0.27.patch';
const parkedAt = join('experiments/ios-notification-delegates-lock/patches', patchFile);
const shippedAt = join('patches', patchFile);
const managerFile =
  'node_modules/expo-notifications/ios/ExpoNotifications/Notifications/NotificationCenterManager.swift';

/**
 * On iOS, expo-notifications 55 keeps its delegates, and the notification
 * responses nobody has taken yet, in two arrays with no lock, on a singleton
 * that outlives every app context. Module registration (the JS thread), the
 * notification handler (Expo's background queue), the teardown of an old
 * context after a reload and the system's callbacks (the main thread) all
 * reach them. Two at once corrupt the array: a dev client that built two React
 * instances back to back died in `NotificationCenterManager.addDelegate` on
 * 2026-10-03, and a store build reaches the same lists from two threads on
 * every `Updates.reloadAsync()`.
 *
 * The patch is Expo's own fix (expo/expo#49554, in 57.0.17 and 58.0.0, never
 * backported to SDK 55) plus a private copy of the small lock helper that
 * fix leans on, which SDK 55's `ExpoModulesCore` lacks. It is Swift, so it
 * moves the iOS fingerprint and can only ship in a store build: until one is
 * cut it waits in `experiments/ios-notification-delegates-lock/`, where
 * `postinstall` does not apply it (see that folder's README).
 */
describe('iOS notification delegate lock', () => {
  const read = (relativePath: string) => readFileSync(join(projectRoot, relativePath), 'utf8');
  const shipped = existsSync(join(projectRoot, shippedAt));
  const parked = existsSync(join(projectRoot, parkedAt));
  const lines = read(shipped ? shippedAt : parkedAt).split('\n');
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1));
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).map((line) => line.slice(1));

  it('lives in one place: parked in experiments/, or shipped from patches/', () => {
    expect([shipped, parked].filter(Boolean)).toHaveLength(1);
  });

  it('is still parked only because 0.1.8 is the newest store build', () => {
    // The next store build is cut from a release bump. Move the patch into
    // patches/ in that commit (README, "Graduating"), so the binary carries
    // it. If that release ships no iOS binary, repin this version instead.
    if (parked) {
      expect(JSON.parse(read('app.json')).expo.version).toBe('0.1.8');
    }
  });

  it('is cut for the installed expo-notifications, and applied by postinstall once shipped', () => {
    const packageJson = JSON.parse(read('package.json'));
    const packageLock = JSON.parse(read('package-lock.json'));

    // patch-package matches a patch to a package by the version in its file
    // name. A bump needs the patch cut again, or dropped: 57.0.17 has the fix.
    expect(packageJson.dependencies['expo-notifications']).toBe('~55.0.27');
    expect(packageLock.packages['node_modules/expo-notifications'].version).toBe('55.0.27');
    expect(packageJson.scripts.postinstall).toBe('patch-package');
  });

  it('touches the notification centre manager and nothing else', () => {
    expect(lines.filter((line) => line.startsWith('diff --git '))).toEqual([
      `diff --git a/${managerFile} b/${managerFile}`,
    ]);
  });

  it('moves both lists off the singleton and behind one lock', () => {
    expect(removed).toContain('  var delegates: [NotificationDelegate] = []');
    expect(removed).toContain('  var pendingResponses: [UNNotificationResponse] = []');

    expect(added).toContain('internal final class NotificationDelegateRegistry {');
    expect(added).toContain('  private let state = Mutex(State())');
    expect(added).toContain('    var delegates: [NotificationDelegate] = []');
    expect(added).toContain('    var pendingResponses: [UNNotificationResponse] = []');
    expect(added).toContain('  private let registry = NotificationDelegateRegistry()');

    // Every write the manager used to make directly now goes through it.
    expect(removed).toContain('    delegates.append(delegate)');
    expect(removed).toContain('      delegates.remove(at: index)');
    expect(removed).toContain('      pendingResponses.append(response)');
    expect(removed).toContain('      pendingResponses.removeAll()');
    expect(added).toContain('    registry.remove(delegate)');
    expect(added).toContain('      registry.appendPendingResponse(response)');
    expect(added).toContain('      registry.removeAllPendingResponses()');
  });

  it('holds the lock for list operations only, never across a call into a delegate', () => {
    // `addDelegate` offers pending responses to the delegate it just added, and
    // a delegate may add or remove delegates from there: calling one with the
    // lock held would deadlock. So the registry hands out snapshots.
    expect(added.filter((line) => line.includes('state.withLock')).map((line) => line.trim())).toEqual([
      'state.withLock { $0.delegates }',
      'state.withLock { $0.pendingResponses }',
      'state.withLock { state in',
      'state.withLock { $0.delegates.removeAll { $0 === delegate } }',
      'state.withLock { $0.pendingResponses.append(response) }',
      'state.withLock { $0.pendingResponses.removeAll() }',
    ]);
    expect(added).toContain('      state.delegates.append(delegate)');
    expect(added).toContain('      return state.pendingResponses');
    expect(added).toContain('    for pendingResponse in registry.add(delegate) {');
  });

  it("carries the lock helper that SDK 55's ExpoModulesCore does not ship", () => {
    expect(added).toContain('private final class Mutex<Value>: @unchecked Sendable {');
    expect(added).toContain('  private let _lock = NSLock()');
    expect(added).toContain('    _lock.lock()');
    expect(added).toContain('    defer { _lock.unlock() }');
    expect(added).toContain('    return try body(&_value)');
  });
});
