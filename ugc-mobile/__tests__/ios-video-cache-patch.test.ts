import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..');

/**
 * expo-video's iOS cache serves AVFoundation from its own URLSession. Its first
 * request per resource asks only for the content information, and the delegate
 * cancels it the moment the response headers arrive -- but the request carried
 * no Range, so the server had already begun streaming the entire file. Measured
 * on 2026-09-08, one cold open of a 465,804-byte rendition cost 2.65-2.87x the
 * file, against 1.0x on Android.
 *
 * The patch asks for two bytes instead, which forces the rest of it: a ranged
 * response reports only its slice in Content-Length, so both the player's
 * content length and the cached media info have to read the total from
 * Content-Range, and the cache has to accept a 206 at all.
 *
 * `node_modules` loses patches on a plain `npm install`, so these assertions
 * are here to fail loudly rather than let the egress quietly return.
 */
describe('expo-video iOS cache patch', () => {
  const patch = readFileSync(join(projectRoot, 'patches/expo-video+55.0.21.patch'), 'utf8');
  const added = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');

  it('is applied on install', () => {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));

    expect(packageJson.scripts.postinstall).toBe('patch-package');
    expect(packageJson.dependencies['expo-video']).toBe('~55.0.21');
  });

  it('bounds the content information request to two bytes', () => {
    expect(added).toContain('urlRequest.setValue("bytes=0-1", forHTTPHeaderField: "Range")');
    // The range belongs to the content information request only; the data
    // requests already carry ranges of their own.
    expect(added).toContain('if loadingRequest.contentInformationRequest != nil {');
  });

  it('reads the resource length from Content-Range rather than the slice', () => {
    expect(added).toContain('internal func totalLengthFromResponse(response: HTTPURLResponse) -> Int64');
    expect(added).toContain(
      'request?.loadingRequest.contentInformationRequest?.contentLength = totalLengthFromResponse(response: response)',
    );
    expect(added).toContain('expectedContentLength: totalLengthFromResponse(response: response),');
  });

  it('lets a ranged response describe the cached resource', () => {
    expect(added).toContain('response.statusCode == 200 || response.statusCode == 206 else {');
    // The cache replays these headers to the player as a synthetic 200, so the
    // slice's own Content-Range and Content-Length must not travel with them.
    expect(added).toContain('internal func wholeResourceHeaderFields(response: HTTPURLResponse) -> [String: String]?');
    expect(added).toContain('headers["Content-Length"] = String(totalLengthFromResponse(response: response))');
    expect(added).toContain('return urlResponse.statusCode == 206 ||');
  });
});
