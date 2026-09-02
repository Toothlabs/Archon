/**
 * `isWebAuthEnabled` and `isConversationOwnershipEnforced` are defined in
 * `@archon/core/auth/config` (the CLI needs them too) and their env matrices
 * live in `packages/core/src/auth/config.test.ts`. What is tested here is what
 * the server adds on top of them.
 */
import { describe, test, expect } from 'bun:test';
import {
  assertWebAuthAtBoot,
  parseAllowedEmails,
  isEmailAllowed,
  getSignupMode,
  isApiGateEnabled,
  isConversationOwnershipEnforced,
  isArchonOwnedAuthPath,
} from './config';

const VALID_SECRET = 'a'.repeat(32);
const PG_URL = 'postgresql://postgres:postgres@localhost:5432/db';

describe('auth/config', () => {
  describe('assertWebAuthAtBoot', () => {
    test('no-op when web auth is disabled, even with a short secret', () => {
      expect(() => assertWebAuthAtBoot({ BETTER_AUTH_SECRET: 'short' })).not.toThrow();
    });

    test('passes when enabled with a >=32-char secret', () => {
      expect(() =>
        assertWebAuthAtBoot({ DATABASE_URL: PG_URL, BETTER_AUTH_SECRET: VALID_SECRET })
      ).not.toThrow();
    });

    test('throws an actionable error when enabled with a short secret', () => {
      expect(() =>
        assertWebAuthAtBoot({ DATABASE_URL: PG_URL, BETTER_AUTH_SECRET: 'short' })
      ).toThrow(/at least 32 characters/);
    });
  });

  describe('parseAllowedEmails', () => {
    test('empty/unset → empty list (open signup)', () => {
      expect(parseAllowedEmails({})).toEqual([]);
      expect(parseAllowedEmails({ ARCHON_AUTH_ALLOWED_EMAILS: '' })).toEqual([]);
    });

    test('splits, trims, lowercases, and drops blanks', () => {
      expect(
        parseAllowedEmails({ ARCHON_AUTH_ALLOWED_EMAILS: ' Alice@X.com , , BOB@y.com ' })
      ).toEqual(['alice@x.com', 'bob@y.com']);
    });
  });

  describe('isEmailAllowed', () => {
    test('empty allowlist → any email allowed (open)', () => {
      expect(isEmailAllowed('anyone@example.com', [])).toBe(true);
    });

    test('accepts a listed email (case-insensitive)', () => {
      expect(isEmailAllowed('Alice@X.com', ['alice@x.com'])).toBe(true);
    });

    test('rejects an unlisted email', () => {
      expect(isEmailAllowed('mallory@evil.com', ['alice@x.com'])).toBe(false);
    });
  });

  describe('getSignupMode', () => {
    test("'disabled' by default when no allowlist (safe default — not open)", () => {
      expect(getSignupMode({})).toBe('disabled');
    });

    test("'allowlist' when emails are configured", () => {
      expect(getSignupMode({ ARCHON_AUTH_ALLOWED_EMAILS: 'a@b.com' })).toBe('allowlist');
    });

    test("'open' only when ARCHON_AUTH_OPEN_SIGNUP=true and no allowlist", () => {
      expect(getSignupMode({ ARCHON_AUTH_OPEN_SIGNUP: 'true' })).toBe('open');
    });

    test('allowlist wins over the open flag', () => {
      expect(
        getSignupMode({ ARCHON_AUTH_ALLOWED_EMAILS: 'a@b.com', ARCHON_AUTH_OPEN_SIGNUP: 'true' })
      ).toBe('allowlist');
    });
  });

  describe('isApiGateEnabled', () => {
    test('true when web auth is enabled and not opted out (default)', () => {
      expect(isApiGateEnabled({ DATABASE_URL: PG_URL, BETTER_AUTH_SECRET: VALID_SECRET })).toBe(
        true
      );
    });

    test('false when web auth is disabled', () => {
      expect(isApiGateEnabled({})).toBe(false);
    });

    test('false when explicitly opted out via ARCHON_WEB_AUTH_REQUIRED=false', () => {
      expect(
        isApiGateEnabled({
          DATABASE_URL: PG_URL,
          BETTER_AUTH_SECRET: VALID_SECRET,
          ARCHON_WEB_AUTH_REQUIRED: 'false',
        })
      ).toBe(false);
    });
  });

  // The re-export is load-bearing: every server caller and every
  // `mock.module('../auth', …)` route test imports the predicate from here.
  describe('isConversationOwnershipEnforced (re-exported from core)', () => {
    // Admission and privacy diverge deliberately: an install where a proxy owns
    // admission still has real distinct users, so it still enforces ownership.
    test('true with web auth even when the API gate is opted out', () => {
      const env = {
        DATABASE_URL: PG_URL,
        BETTER_AUTH_SECRET: VALID_SECRET,
        ARCHON_WEB_AUTH_REQUIRED: 'false',
      };
      expect(isApiGateEnabled(env)).toBe(false);
      expect(isConversationOwnershipEnforced(env)).toBe(true);
    });

    test('false on a solo/SQLite install, where the gate is also off', () => {
      expect(isApiGateEnabled({})).toBe(false);
      expect(isConversationOwnershipEnforced({})).toBe(false);
    });
  });

  describe('isArchonOwnedAuthPath', () => {
    test('exempts Archon-owned /api/auth/* paths (fall through, not Better Auth)', () => {
      for (const p of [
        '/api/auth/status',
        '/api/auth/github',
        '/api/auth/github/device/start',
        '/api/auth/github/device/poll',
        '/api/auth/providers',
        '/api/auth/providers/openrouter',
        '/api/auth/providers/claude/oauth/start', // reserved for PR-3
        '/api/auth/me/ai-prefs',
        '/api/auth/me/ai-prefs/tiers',
        '/api/auth/me/identities',
        '/api/auth/me/identities/cli/rasmus',
      ]) {
        expect(isArchonOwnedAuthPath(p)).toBe(true);
      }
    });

    test('does NOT exempt Better Auth-owned paths (those it must handle)', () => {
      for (const p of [
        '/api/auth/sign-in',
        '/api/auth/sign-up',
        '/api/auth/sign-out',
        '/api/auth/get-session',
        '/api/auth/providersX', // prefix guard: must be exact or under '/'
        '/api/auth/githubbed',
        '/api/auth/me/ai-prefsX',
        '/api/auth/me/identitiesX',
        '/api/auth',
      ]) {
        expect(isArchonOwnedAuthPath(p)).toBe(false);
      }
    });
  });
});
