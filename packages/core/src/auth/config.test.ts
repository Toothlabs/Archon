import { describe, test, expect } from 'bun:test';
import { isWebAuthEnabled, isConversationOwnershipEnforced } from './config';

const VALID_SECRET = 'a'.repeat(32);
const PG_URL = 'postgresql://postgres:postgres@localhost:5432/db';

describe('auth/config', () => {
  describe('isWebAuthEnabled', () => {
    test('true only when both DATABASE_URL and BETTER_AUTH_SECRET are set', () => {
      expect(isWebAuthEnabled({ DATABASE_URL: PG_URL, BETTER_AUTH_SECRET: VALID_SECRET })).toBe(
        true
      );
    });

    test('false when DATABASE_URL is missing (SQLite/solo install)', () => {
      expect(isWebAuthEnabled({ BETTER_AUTH_SECRET: VALID_SECRET })).toBe(false);
    });

    test('false when BETTER_AUTH_SECRET is missing', () => {
      expect(isWebAuthEnabled({ DATABASE_URL: PG_URL })).toBe(false);
    });

    test('false when both are missing', () => {
      expect(isWebAuthEnabled({})).toBe(false);
    });
  });

  describe('isConversationOwnershipEnforced', () => {
    test('true when web auth is enabled', () => {
      expect(
        isConversationOwnershipEnforced({ DATABASE_URL: PG_URL, BETTER_AUTH_SECRET: VALID_SECRET })
      ).toBe(true);
    });

    // The proxy-header install has real distinct users and no Better Auth.
    test('true when only ARCHON_WEB_AUTH_HEADER is set (proxy-authenticated install)', () => {
      expect(isConversationOwnershipEnforced({ ARCHON_WEB_AUTH_HEADER: 'X-Archon-User' })).toBe(
        true
      );
    });

    // Unlike the API gate, opting out of server-side admission does not opt out
    // of privacy: a proxy owning admission still has distinct users.
    test('true with web auth even when ARCHON_WEB_AUTH_REQUIRED=false', () => {
      expect(
        isConversationOwnershipEnforced({
          DATABASE_URL: PG_URL,
          BETTER_AUTH_SECRET: VALID_SECRET,
          ARCHON_WEB_AUTH_REQUIRED: 'false',
        })
      ).toBe(true);
    });

    test('false on a solo/SQLite install (no Postgres, no header)', () => {
      expect(isConversationOwnershipEnforced({})).toBe(false);
      expect(isConversationOwnershipEnforced({ DATABASE_URL: PG_URL })).toBe(false);
    });

    // Keys on the variable being SET, not on the default name being honored.
    test('false when the header var is present but empty', () => {
      expect(isConversationOwnershipEnforced({ ARCHON_WEB_AUTH_HEADER: '' })).toBe(false);
    });
  });
});
