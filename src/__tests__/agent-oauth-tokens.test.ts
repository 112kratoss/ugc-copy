import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AGENT_ACCESS_TOKEN_PREFIX,
  AGENT_ACCESS_TOKEN_TTL_SECONDS,
  AGENT_AUTHORIZATION_CODE_TTL_SECONDS,
  AGENT_REFRESH_REUSE_GRACE_SECONDS,
  AGENT_REFRESH_TOKEN_PREFIX,
  AGENT_REFRESH_TOKEN_TTL_SECONDS,
  codeChallengeS256,
  constantTimeEqual,
  hashAgentSecret,
  isAgentSecret,
  isCodeChallenge,
  isCodeVerifier,
  mintAgentSecret,
  verifierMatchesChallenge,
} from '@/lib/agent-oauth-tokens';
import { isAppAgentAccessToken } from '@/lib/agent-token';

// The secrets of the app's own authorization server (docs/archive/agent-token-broker-plan-2026-11-26.md).
describe('agent OAuth secrets', () => {
  it('mints 256 random bits behind a prefix, different every time', () => {
    const first = mintAgentSecret(AGENT_ACCESS_TOKEN_PREFIX);
    const second = mintAgentSecret(AGENT_ACCESS_TOKEN_PREFIX);
    expect(first).toMatch(/^mbat_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.slice(5), 'base64url')).toHaveLength(32);
    expect(first).not.toBe(second);
  });

  it('knows its own secrets by shape, and takes nothing else', () => {
    const token = mintAgentSecret(AGENT_REFRESH_TOKEN_PREFIX);
    expect(isAgentSecret(token, AGENT_REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(isAgentSecret(token, AGENT_ACCESS_TOKEN_PREFIX)).toBe(false);
    expect(isAgentSecret(`${token}x`, AGENT_REFRESH_TOKEN_PREFIX)).toBe(false);
    expect(isAgentSecret(token.slice(0, -1), AGENT_REFRESH_TOKEN_PREFIX)).toBe(false);
    expect(isAgentSecret(`mbrt_${'a'.repeat(42)}=`, AGENT_REFRESH_TOKEN_PREFIX)).toBe(false);
    expect(isAgentSecret(null, AGENT_REFRESH_TOKEN_PREFIX)).toBe(false);
    expect(isAgentSecret(42, AGENT_REFRESH_TOKEN_PREFIX)).toBe(false);
  });

  it('tells an app access token from a JWT by shape alone', () => {
    expect(isAppAgentAccessToken(mintAgentSecret(AGENT_ACCESS_TOKEN_PREFIX))).toBe(true);
    expect(isAppAgentAccessToken(mintAgentSecret(AGENT_REFRESH_TOKEN_PREFIX))).toBe(false);
    expect(isAppAgentAccessToken('eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln')).toBe(false);
    expect(isAppAgentAccessToken('mbat_short')).toBe(false);
    expect(isAppAgentAccessToken(null)).toBe(false);
    expect(isAppAgentAccessToken(undefined)).toBe(false);
  });

  it('stores a secret as base64url(SHA-256), the form Supabase Auth keeps a client secret in', () => {
    const hash = hashAgentSecret('correct horse battery staple');
    expect(hash).toBe(createHash('sha256').update('correct horse battery staple').digest('base64url'));
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashAgentSecret('a')).not.toBe(hashAgentSecret('b'));
  });

  it('compares in constant time, whatever the lengths', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  it('checks PKCE S256 against the RFC 7636 example', () => {
    // RFC 7636, appendix B.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(codeChallengeS256(verifier)).toBe(challenge);
    expect(verifierMatchesChallenge(verifier, challenge)).toBe(true);
    expect(verifierMatchesChallenge(`${verifier}x`, challenge)).toBe(false);
    // `plain` is not a method here: a verifier equal to the challenge does not match.
    expect(verifierMatchesChallenge(challenge, challenge)).toBe(false);
  });

  it('takes only well-formed verifiers and S256 challenges', () => {
    expect(isCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isCodeVerifier('a'.repeat(128))).toBe(true);
    expect(isCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isCodeVerifier(`${'a'.repeat(43)} `)).toBe(false);
    expect(isCodeVerifier(`${'a'.repeat(42)}+`)).toBe(false);
    expect(isCodeChallenge('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(isCodeChallenge('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM=')).toBe(false);
    expect(isCodeChallenge('short')).toBe(false);
    expect(verifierMatchesChallenge('too-short', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
  });

  it('keeps the lifetimes the plan records', () => {
    expect(AGENT_ACCESS_TOKEN_TTL_SECONDS).toBe(3600);
    expect(AGENT_REFRESH_TOKEN_TTL_SECONDS).toBe(90 * 86_400);
    expect(AGENT_AUTHORIZATION_CODE_TTL_SECONDS).toBe(120);
    expect(AGENT_REFRESH_REUSE_GRACE_SECONDS).toBe(10);
  });
});
