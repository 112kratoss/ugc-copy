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
    expect(functionSource).toContain('WEBHOOK_SECRET');
    expect(functionSource).toContain('fetch(forwardUrl');
    expect(functionSource).not.toContain('@ts-nocheck');
    expect(functionSource).not.toContain('recordInfo');
    expect(functionSource).not.toContain('generations');
  });

  it('allows unauthenticated provider callbacks while keeping verification in the function', () => {
    expect(config).toContain('[functions.kie-webhook]');
    expect(config).toContain('verify_jwt = false');
  });
});
