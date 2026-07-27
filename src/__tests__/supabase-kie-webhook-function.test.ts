import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const functionPath = path.resolve(process.cwd(), 'supabase/functions/kie-webhook/index.ts');
const functionSource = fs.existsSync(functionPath)
  ? fs.readFileSync(functionPath, 'utf8')
  : '';
const configPath = path.resolve(process.cwd(), 'supabase/config.toml');
const config = fs.readFileSync(configPath, 'utf8');

describe('Supabase KIE webhook forwarding function', () => {
  it('keeps the legacy edge function source-controlled as a Vercel forwarding shim', () => {
    expect(functionSource).toContain('serve(async (request: Request)');
    expect(functionSource).toContain('/api/webhooks/kie');
    expect(functionSource).toContain('KIE_WEBHOOK_HMAC_KEY');
    expect(functionSource).toContain('KIE_PROVIDER_WEBHOOK_SECRET');
    expect(functionSource).toContain("searchParams.set('generationId', generationId)");
    expect(functionSource).not.toContain("configuredValue('WEBHOOK_SECRET')");
    expect(functionSource).toContain('Webhook forwarding key is not configured');
    expect(functionSource).toContain("'x-webhook-payload-signature'");
    expect(functionSource).not.toContain("'x-webhook-signature'");
    expect(functionSource).toContain("'kie-webhook-v2'");
    expect(functionSource).toContain('fetch(forwardUrl');
    expect(functionSource).toContain('AbortSignal.timeout(FORWARD_TIMEOUT_MS)');
    expect(functionSource).toContain('const FORWARD_TIMEOUT_MS = 15_000');
    expect(functionSource).not.toContain('@ts-nocheck');
    expect(functionSource).not.toContain('recordInfo');
    expect(functionSource).not.toContain('generations');
  });

  it('documents the provider-required query credential and its rotation boundary', () => {
    const runbook = fs.readFileSync(
      path.resolve(process.cwd(), 'docs/production-deployment-runbook.md'),
      'utf8',
    );

    expect(runbook).toContain(
      'Kie only supports a callback URL for this integration',
    );
    expect(runbook).toContain(
      'must not be copied into application logs',
    );
  });

  it('compares the provider secret in constant time via fixed-length digests', () => {
    // The query secret must never be compared character-by-character with an
    // early length exit: both sides are hashed to fixed-length SHA-256
    // digests and the digests are compared byte-for-byte.
    expect(functionSource).toContain("crypto.subtle.digest('SHA-256', encoder.encode(left))");
    expect(functionSource).toContain("crypto.subtle.digest('SHA-256', encoder.encode(right))");
    expect(functionSource).toContain('leftBytes[index] ^ rightBytes[index]');
    expect(functionSource).not.toContain('left.length !== right.length');
    expect(functionSource).not.toContain('charCodeAt');
    // Every configured secret is checked; no early exit on first match.
    expect(functionSource).toContain('providerSecrets.map((secret) => safeEqual(secret, requestSecret))');
  });

  it('allows unauthenticated provider callbacks while keeping verification in the function', () => {
    expect(config).toContain('[functions.kie-webhook]');
    expect(config).toContain('verify_jwt = false');
  });
});
