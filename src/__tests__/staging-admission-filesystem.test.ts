import { describe, expect, it, vi } from 'vitest';
import { isLocalLockFilesystem, localLockFilesystem } from '@/lib/staging-workspace';

// The real-filesystem suites (staging-workspace and the media files that stage)
// exercise admission on whatever host runs them. This pins the decision and
// what it is asked for both platforms on either host: a builtin spy does not
// reach the module's statfs in this vitest setup, so the reader is passed in.
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
    // NFS, CIFS, SMB2, FUSE, btrfs, xfs
    for (const type of [0x6969, 0xff534d42, 0xfe534d42, 0x65735546, 0x9123683e, 0x58465342]) {
      expect(isLocalLockFilesystem('linux', type, null)).toBe(false);
      expect(isLocalLockFilesystem('linux', type, type)).toBe(false);
    }
  });

  it('refuses every other platform', () => {
    expect(isLocalLockFilesystem('win32', 0x19, 0x19)).toBe(false);
    expect(isLocalLockFilesystem('freebsd', 0xef53, 0xef53)).toBe(false);
  });

  function statfsAnswering(types: Record<string, number>) {
    return vi.fn(async (target: string) => ({ type: types[target] ?? -1 }));
  }

  it('compares the staging root with `/` on macOS, not with itself', async () => {
    const elsewhere = statfsAnswering({ '/staging': 0x1a, '/': 0x19 });
    await expect(localLockFilesystem('/staging', elsewhere, 'darwin')).resolves.toBe(false);
    expect(elsewhere.mock.calls).toEqual([['/staging'], ['/']]);
    await expect(localLockFilesystem('/staging', statfsAnswering({ '/staging': 0x19, '/': 0x19 }), 'darwin'))
      .resolves.toBe(true);
  });

  it('refuses on macOS while `/` cannot be read, instead of throwing', async () => {
    const read = vi.fn(async (target: string) => {
      if (target === '/') throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return { type: 0x19 };
    });
    await expect(localLockFilesystem('/staging', read, 'darwin')).resolves.toBe(false);
  });

  it('reads only the staging root on Linux', async () => {
    const read = statfsAnswering({ '/tmp/staging': 0xef53 });
    await expect(localLockFilesystem('/tmp/staging', read, 'linux')).resolves.toBe(true);
    expect(read.mock.calls).toEqual([['/tmp/staging']]);
  });
});
