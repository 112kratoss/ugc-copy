import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the installed Swift implementation, not a JS replica. Requires macOS/Xcode.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = process.argv[2] ?? join(root, 'node_modules/expo-video/ios');
const directory = mkdtempSync(join(tmpdir(), 'video-cache-test-'));
try {
  const manager = readFileSync(join(sourceRoot, 'Cache/VideoCacheManager.swift'), 'utf8')
    .replace('import ExpoModulesCore', 'import Foundation')
    .replace('private func fileIsOpen', 'func fileIsOpen');
  const info = readFileSync(join(sourceRoot, 'Cache/MediaInfo.swift'), 'utf8')
    .replace('import ExpoModulesCore', '');
  const asset = readFileSync(join(sourceRoot, 'VideoAsset.swift'), 'utf8');
  if (asset.includes('unregisterOpenFile')) throw new Error('VideoAsset must not release a MediaFileHandle-owned registration');
  const harness = `
struct VideoCacheException: Error { init(_ message: String) {} }
class VideoManager { static let shared = VideoManager(); var hasRegisteredPlayers = false }
struct ProbeLog { func warn(_ message: String) {} }
let log = ProbeLog()
class VideoAsset { static func pathForUrl(url: URL, fileExtension: String) -> String? { nil } }
let manager = VideoCacheManager.shared
let url = URL(fileURLWithPath: "/tmp/shared-player.mp4")
manager.registerOpenFile(at: url)
manager.registerOpenFile(at: URL(string: url.path)!)
manager.unregisterOpenFile(at: url)
precondition(manager.fileIsOpen(url: url), "First player must not release second player's cache file")
manager.unregisterOpenFile(at: url)
precondition(!manager.fileIsOpen(url: url), "Last player must release its cache file")
let sidecar = URL(fileURLWithPath: "/tmp/shared-player.mp4&mediaInfo")
var original: MediaInfo? = MediaInfo(expectedContentLength: 1024, mimeType: "video/mp4", supportsByteRangeAccess: true, headerFields: nil, savePath: sidecar.path)
var decoded: MediaInfo? = try JSONDecoder().decode(MediaInfo.self, from: original!.encodeToData()!)
precondition(decoded!.expectedContentLength == 1024)
decoded = nil
precondition(manager.fileIsOpen(url: sidecar), "Decoded metadata must not unregister another owner's file")
original = nil
precondition(!manager.fileIsOpen(url: sidecar))
// Keep one permanent owner while AVPlayer-like queues create/release others.
manager.registerOpenFile(at: url)
DispatchQueue.concurrentPerform(iterations: 100_000) { index in
  manager.registerOpenFile(at: url)
  precondition(manager.fileIsOpen(url: url))
  manager.unregisterOpenFile(at: url)
  precondition(manager.fileIsOpen(url: url))
  let unique = URL(fileURLWithPath: "/tmp/player-\\(index).mp4")
  manager.registerOpenFile(at: unique)
  precondition(manager.fileIsOpen(url: unique))
  manager.unregisterOpenFile(at: unique)
}
manager.unregisterOpenFile(at: url)
precondition(!manager.fileIsOpen(url: url))
print("PASS: overlapping owners, decoded metadata, 100000 concurrent player lifecycles")
`;
  const source = join(directory, 'main.swift');
  const binary = join(directory, 'cache-test');
  writeFileSync(source, `${manager}\n${info}\n${harness}`);
  execFileSync('swiftc', ['-swift-version', '5', '-sanitize=thread', source, '-o', binary], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit', env: { ...process.env, TSAN_OPTIONS: 'halt_on_error=1' } });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
