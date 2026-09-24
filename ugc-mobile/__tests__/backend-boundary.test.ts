import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(__dirname, '..');
const sourceRoots = ['app', 'components', 'lib'] as const;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...sourceFiles(absolutePath));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function relativePath(filePath: string) {
  return path.relative(mobileRoot, filePath).replaceAll(path.sep, '/');
}

const mobileSourceFiles = sourceRoots.flatMap((root) => sourceFiles(path.join(mobileRoot, root)));
const AI_DATA_DISCLOSURE_FILE = 'lib/ai-data-consent.ts';

describe('mobile backend boundary', () => {
  it('routes HTTP business calls through the shared API client', () => {
    const directFetchFiles = mobileSourceFiles
      .filter((filePath) => relativePath(filePath) !== 'lib/api-client.ts')
      .filter((filePath) => /\bfetch\s*\(/.test(readFileSync(filePath, 'utf8')))
      .map(relativePath);

    expect(directFetchFiles).toEqual([]);
  });

  it('keeps Supabase database and storage authority out of mobile app code', () => {
    const disallowedSupabaseFiles = mobileSourceFiles
      .filter((filePath) => !['lib/media.ts', 'lib/supabase.ts'].includes(relativePath(filePath)))
      .filter((filePath) => /supabase\.(from|rpc|functions|storage|channel|realtime)\b/.test(readFileSync(filePath, 'utf8')))
      .map(relativePath);

    expect(disallowedSupabaseFiles).toEqual([]);
  });

  it('allows only server-authorized signed Supabase uploads from mobile', () => {
    const mediaSource = readFileSync(path.join(mobileRoot, 'lib/media.ts'), 'utf8');
    const uploadSource = readFileSync(path.join(mobileRoot, 'lib/upload-file.ts'), 'utf8');

    expect(mediaSource).toContain('createMediaUpload');
    expect(mediaSource).toContain('createMediaReadUrl');
    expect(mediaSource).toContain('createProfileMediaUpload');
    // Resource attachments go through the same server-signed path as every
    // other mobile upload rather than posting bytes through the API.
    expect(mediaSource).toContain('signPostResourceFileUpload');
    expect(mediaSource).toContain('finalizeUpload');
    expect(mediaSource).toContain('finalized.bucket !== uploadIntent.bucket');
    expect(mediaSource).toContain('finalized.path !== uploadIntent.path');
    expect(mediaSource.match(/await uploadUriToSignedUrl/g)).toHaveLength(4);
    expect(uploadSource).toContain("httpMethod: 'PUT'");
    expect(uploadSource).not.toContain('.arrayBuffer()');
    expect(mediaSource).not.toMatch(/\.upload\s*\(/);
    expect(mediaSource).not.toMatch(/createSignedUrl\s*\(/);
    expect(mediaSource).not.toMatch(/\.download\s*\(/);
    expect(mediaSource).not.toMatch(/\.remove\s*\(/);
  });

  it('keeps provider, payment, and service-role secrets server-side', () => {
    const openAiName = /\bOpenAI\b/;
    const kieName = /kie\.ai/i;
    const forbiddenPatterns = [
      /\bRazorpay\b/,
      openAiName,
      /api\.openai/i,
      /\bKIE\b/,
      kieName,
      /api\.replicate/i,
      /fal\.ai/i,
      /\bproviderModel\b/,
      /\bprovider_model\b/,
      /\badapterName\b/,
      /\bSUPABASE_SERVICE\b/,
      /\bservice_role\b/,
    ];
    // The one file that may name the companies: the disclosure App Review
    // requires before a prompt or media goes to a third-party AI service
    // (guidelines 5.1.1(i) and 5.1.2(i)). It names them for people to read. It
    // still may not carry an endpoint, a model mapping or a key.
    const disclosureNames = new Set([openAiName, kieName]);
    const violatingFiles = mobileSourceFiles
      .filter((filePath) => {
        const source = readFileSync(filePath, 'utf8');
        const patterns = relativePath(filePath) === AI_DATA_DISCLOSURE_FILE
          ? forbiddenPatterns.filter((pattern) => !disclosureNames.has(pattern))
          : forbiddenPatterns;
        return patterns.some((pattern) => pattern.test(source));
      })
      .map(relativePath);

    expect(violatingFiles).toEqual([]);
    expect(readFileSync(path.join(mobileRoot, AI_DATA_DISCLOSURE_FILE), 'utf8')).toMatch(kieName);
  });
});
