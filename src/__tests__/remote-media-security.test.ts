import { describe, expect, it, vi } from 'vitest';

import {
  downloadAllowlistedRemoteMedia,
  isPrivateOrSpecialIp,
  RemoteMediaSecurityError,
} from '@/lib/remote-media-security';
import {
  isCanonicalStorageObjectPath,
  isStorageObjectOwnedByUser,
} from '@/lib/storage-ownership';

describe('remote media security', () => {
  it('rejects hosts outside the explicit allowlist before fetching', async () => {
    const fetcher = vi.fn();
    await expect(downloadAllowlistedRemoteMedia({
      url: 'https://attacker.invalid/input.png',
      kind: 'image',
      allowedHosts: ['media.example.test'],
      lookup: vi.fn(),
      fetcher,
    })).rejects.toBeInstanceOf(RemoteMediaSecurityError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects allowlisted hosts that resolve to private addresses', async () => {
    const fetcher = vi.fn();
    await expect(downloadAllowlistedRemoteMedia({
      url: 'https://media.example.test/input.png',
      kind: 'image',
      allowedHosts: ['media.example.test'],
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
      fetcher,
    })).rejects.toThrow('private or unsafe');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies before buffering them', async () => {
    await expect(downloadAllowlistedRemoteMedia({
      url: 'https://media.example.test/input.png',
      kind: 'image',
      allowedHosts: ['media.example.test'],
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetcher: vi.fn(async () => new Response('small', {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(30 * 1024 * 1024),
        },
      })),
    })).rejects.toThrow('exceeds the allowed size');
  });

  it('downloads allowlisted public media with a timeout and manual redirects', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    const result = await downloadAllowlistedRemoteMedia({
      url: 'https://media.example.test/input.png',
      kind: 'image',
      allowedHosts: ['media.example.test'],
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetcher,
    });
    expect(result.blob.size).toBe(8);
    expect(result.blob.type).toBe('image/png');
  });

  it('rejects content that does not match its declared media type', async () => {
    await expect(downloadAllowlistedRemoteMedia({
      url: 'https://media.example.test/not-really-an-image.png',
      kind: 'image',
      allowedHosts: ['media.example.test'],
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetcher: vi.fn(async () => new Response('<html>not an image</html>', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
    })).rejects.toThrow('do not match');
  });

  it('fails closed with a security error when a fetch adapter omits response headers', async () => {
    await expect(downloadAllowlistedRemoteMedia({
      url: 'https://media.example.test/input.png',
      kind: 'image',
      allowedHosts: ['media.example.test'],
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetcher: vi.fn(async () => ({
        ok: true,
        status: 200,
      }) as Response),
    })).rejects.toMatchObject({
      name: RemoteMediaSecurityError.name,
      message: 'Remote response is not valid image media.',
    });
  });

  it('recognizes private IPs and rejects cross-user or traversal storage paths', () => {
    expect(isPrivateOrSpecialIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrSpecialIp('10.0.0.1')).toBe(true);
    expect(isPrivateOrSpecialIp('::1')).toBe(true);
    expect(isPrivateOrSpecialIp('ff02::1')).toBe(true);
    expect(isPrivateOrSpecialIp('2001:db8::1')).toBe(true);
    expect(isPrivateOrSpecialIp('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateOrSpecialIp('8.8.8.8')).toBe(false);
    expect(isCanonicalStorageObjectPath('user-1/generation/file.png')).toBe(true);
    expect(isCanonicalStorageObjectPath('user-1/%2e%2e/victim/file.png')).toBe(false);
    expect(isCanonicalStorageObjectPath('user-1/%25252e%25252e/victim/file.png')).toBe(false);
    expect(isStorageObjectOwnedByUser('victim-1/file.png', 'user-1')).toBe(false);
    expect(isStorageObjectOwnedByUser('user-1/file.png', 'user-1')).toBe(true);
  });
});
