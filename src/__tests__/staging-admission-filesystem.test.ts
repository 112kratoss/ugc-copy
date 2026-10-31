import { describe, expect, it } from 'vitest';
import { isLocalLockFilesystem } from '@/lib/staging-workspace';

// The real-filesystem suites (staging-workspace and the media files that stage)
// exercise admission on whatever host runs them. This pins the decision itself
// for both platforms on either host.
describe('staging admission filesystem', () => {
  // macOS numbers a filesystem as it registers at boot: the development Mac's
  // APFS was 0x1a until a reboot on 2026-10-31 and 0x19 after it.
  it.each([0x19, 0x1a])('admits on macOS the system volume\'s filesystem, numbered %i this boot', (apfs) => {
    expect(isLocalLockFilesystem('darwin', apfs, apfs)).toBe(true);
  });

  it('refuses on macOS any other filesystem, whatever its number', () => {
    expect(isLocalLockFilesystem('darwin', 0x1a, 0x19)).toBe(false);
    expect(isLocalLockFilesystem('darwin', 0x19, 0x1a)).toBe(false);
    expect(isLocalLockFilesystem('darwin', 0x19, null)).toBe(false);
  });

  it('keeps the Linux list: tmpfs, overlayfs and ext4 only', () => {
    for (const type of [0x01021994, 0x794c7630, 0xef53]) {
      expect(isLocalLockFilesystem('linux', type, null)).toBe(true);
    }
    expect(isLocalLockFilesystem('linux', 0x6969, null)).toBe(false); // NFS
    expect(isLocalLockFilesystem('linux', 0x6969, 0x6969)).toBe(false);
  });

  it('refuses every other platform', () => {
    expect(isLocalLockFilesystem('win32', 0x19, 0x19)).toBe(false);
    expect(isLocalLockFilesystem('freebsd', 0xef53, 0xef53)).toBe(false);
  });
});
