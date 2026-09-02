import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

// withTransaction forwards its callback to the shared mockQuery instance, so
// tests can queue mockResolvedValueOnce in transactional order. To simulate a
// transaction rollback, mockRejectedValueOnce on the INSERT inside the txn —
// the outer try/catch in users.ts decides whether to recover (UNIQUE race) or
// rethrow (any other error).
const mockWithTransaction = mock(
  async (fn: (q: typeof mockQuery) => Promise<unknown>) => await fn(mockQuery)
);

mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
  getDatabase: () => ({ withTransaction: mockWithTransaction }),
}));

import {
  findOrCreateUserByPlatformIdentity,
  getUserById,
  updateUserDisplayName,
  linkGithubIdentity,
  linkPlatformIdentity,
  unlinkPlatformIdentity,
  listUserIdentities,
  updateUserGithubProfile,
  GithubIdentityConflictError,
  PlatformIdentityConflictError,
} from './users';
import type { User, UserIdentity } from '../types';

const userRow = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  display_name: null,
  email: null,
  role: 'admin',
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

const identityRow = (overrides: Partial<UserIdentity> = {}): UserIdentity => ({
  id: 'identity-1',
  user_id: 'user-1',
  platform: 'slack',
  platform_user_id: 'U123',
  platform_display_name: null,
  created_at: new Date(),
  ...overrides,
});

describe('users', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockWithTransaction.mockClear();
  });

  describe('getUserById', () => {
    test('returns user when found', async () => {
      const u = userRow();
      mockQuery.mockResolvedValueOnce(createQueryResult([u]));
      const result = await getUserById('user-1');
      expect(result).toEqual(u);
      expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM remote_agent_users WHERE id = $1', [
        'user-1',
      ]);
    });

    test('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const result = await getUserById('user-missing');
      expect(result).toBeNull();
    });
  });

  describe('findOrCreateUserByPlatformIdentity', () => {
    test('returns existing user when identity row exists', async () => {
      const u = userRow();
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([u]));

      const result = await findOrCreateUserByPlatformIdentity('slack', 'U123');

      expect(result).toEqual(u);
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockWithTransaction).not.toHaveBeenCalled();
    });

    test('returns the role from the user row (identity seam, defaults admin)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ role: 'admin' })]));

      const result = await findOrCreateUserByPlatformIdentity('web', 'web-user-1');

      expect(result.role).toBe('admin');
    });

    test('propagates a non-default role from the user row (member round-trip)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ role: 'member' })]));

      const result = await findOrCreateUserByPlatformIdentity('web', 'web-user-2');

      // Confirms the column value is plumbed through, not hardcoded to 'admin'.
      expect(result.role).toBe('member');
    });

    test('backfills both identity and user display_name when both previously null', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Alice');

      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'UPDATE remote_agent_user_identities SET platform_display_name = $1 WHERE id = $2',
        ['Alice', 'identity-1']
      );
    });

    test('backfills only user.display_name when identity already has one (asymmetric)', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([identityRow({ platform_display_name: 'Stale' })])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ display_name: null })]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Alice');

      // Identity already has display_name → no identity UPDATE; user row gets the backfill.
      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('UPDATE remote_agent_users SET display_name'),
        ['Alice', 'user-1']
      );
    });

    test('does not backfill when both rows already have display_name', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([identityRow({ platform_display_name: 'Existing' })])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ display_name: 'Existing' })]));

      await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Alice');

      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test('backfill failure does not block user resolution', async () => {
      const u = userRow();
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([u]));
      // Backfill UPDATE on the identity row fails — must be swallowed.
      mockQuery.mockRejectedValueOnce(new Error('connection reset'));

      const result = await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Alice');

      expect(result).toEqual(u);
    });

    test('creates new user + identity when first seen', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const newUser = userRow({ id: 'user-new', display_name: 'Bob' });
      mockQuery.mockResolvedValueOnce(createQueryResult([newUser]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const result = await findOrCreateUserByPlatformIdentity('telegram', '7654321', 'Bob');

      expect(result).toEqual(newUser);
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO remote_agent_users (display_name) VALUES ($1) RETURNING *',
        ['Bob']
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('INSERT INTO remote_agent_user_identities'),
        ['user-new', 'telegram', '7654321', 'Bob']
      );
    });

    test('recovers from race on UNIQUE-constraint violation (PG sqlstate 23505)', async () => {
      const winner = userRow({ id: 'user-winner' });
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ id: 'user-loser' })]));
      const pgErr = Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
      mockQuery.mockRejectedValueOnce(pgErr);
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow({ user_id: 'user-winner' })]));
      mockQuery.mockResolvedValueOnce(createQueryResult([winner]));

      const result = await findOrCreateUserByPlatformIdentity('github', 'alice');

      expect(result).toEqual(winner);
    });

    test('recovers from race on UNIQUE-constraint violation (SQLite error message)', async () => {
      const winner = userRow({ id: 'user-winner-sqlite' });
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ id: 'user-loser' })]));
      mockQuery.mockRejectedValueOnce(
        new Error(
          'UNIQUE constraint failed: remote_agent_user_identities.platform, remote_agent_user_identities.platform_user_id'
        )
      );
      mockQuery.mockResolvedValueOnce(
        createQueryResult([identityRow({ user_id: 'user-winner-sqlite' })])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([winner]));

      const result = await findOrCreateUserByPlatformIdentity('discord', '321');

      expect(result).toEqual(winner);
    });

    test('rethrows non-UNIQUE errors WITHOUT attempting race recovery', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockRejectedValueOnce(new Error('serialization failure'));
      // No re-SELECT should happen — if the narrowed catch is widened by a
      // future refactor, this assertion catches it.

      await expect(findOrCreateUserByPlatformIdentity('slack', 'U999')).rejects.toThrow(
        'serialization failure'
      );
      // Exactly 3 queries: initial identity SELECT + INSERT user + INSERT identity (failed).
      // No recovery SELECT means the narrowed catch path held.
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    test('rethrows when UNIQUE fires but recovery SELECT returns empty', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockRejectedValueOnce(
        Object.assign(new Error('UNIQUE constraint failed'), { code: '23505' })
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(findOrCreateUserByPlatformIdentity('slack', 'U999')).rejects.toThrow(
        'UNIQUE constraint failed'
      );
    });

    test('repairs orphaned identity (user_id points to deleted user)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const repaired = userRow({ id: 'user-repaired', display_name: 'Carol' });
      mockQuery.mockResolvedValueOnce(createQueryResult([repaired]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const result = await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Carol');

      expect(result).toEqual(repaired);
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateUserDisplayName', () => {
    test('issues UPDATE with NOW() and provided values', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      await updateUserDisplayName('user-1', 'NewName');
      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_users SET display_name = $1, updated_at = NOW() WHERE id = $2',
        ['NewName', 'user-1']
      );
    });
  });

  describe('linkGithubIdentity', () => {
    const githubIdentity = (overrides: Partial<UserIdentity> = {}): UserIdentity =>
      identityRow({ id: 'id-gh', platform: 'github', platform_user_id: 'alice', ...overrides });

    test('throws GithubIdentityConflictError when login maps to a different user', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([githubIdentity({ user_id: 'user-other' })])
      );
      await expect(linkGithubIdentity('user-1', 'alice')).rejects.toBeInstanceOf(
        GithubIdentityConflictError
      );
      // Only the SELECT ran — a conflict must not touch the identity row.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('updates platform_display_name (no throw) when login already belongs to the same user', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([githubIdentity({ user_id: 'user-1' })]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      await expect(linkGithubIdentity('user-1', 'alice')).resolves.toBeUndefined();
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'UPDATE remote_agent_user_identities SET platform_display_name = $1 WHERE id = $2',
        ['alice', 'id-gh']
      );
    });

    test('inserts a new identity row when the login is unseen', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([githubIdentity()]));
      await linkGithubIdentity('user-1', 'alice');
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('INSERT INTO remote_agent_user_identities'),
        ['user-1', 'github', 'alice', 'alice']
      );
    });

    test('recovers from a concurrent-insert race when the winner is the same user', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([])); // SELECT: not found yet
      mockQuery.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        })
      );
      // Re-SELECT after the UNIQUE violation: the winner is us → no conflict.
      mockQuery.mockResolvedValueOnce(createQueryResult([githubIdentity({ user_id: 'user-1' })]));
      await expect(linkGithubIdentity('user-1', 'alice')).resolves.toBeUndefined();
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    test('race recovery surfaces a conflict when the winner is a different user', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([])); // SELECT: not found yet
      mockQuery.mockRejectedValueOnce(
        Object.assign(new Error('UNIQUE constraint failed'), { code: '23505' })
      );
      mockQuery.mockResolvedValueOnce(
        createQueryResult([githubIdentity({ user_id: 'user-other' })])
      );
      await expect(linkGithubIdentity('user-1', 'alice')).rejects.toBeInstanceOf(
        GithubIdentityConflictError
      );
    });

    test('rethrows a non-UNIQUE insert error without a recovery SELECT', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([])); // SELECT
      mockQuery.mockRejectedValueOnce(new Error('connection reset')); // INSERT
      await expect(linkGithubIdentity('user-1', 'alice')).rejects.toThrow('connection reset');
      expect(mockQuery).toHaveBeenCalledTimes(2); // no third (recovery) query
    });
  });

  describe('linkPlatformIdentity', () => {
    const cliIdentity = (overrides: Partial<UserIdentity> = {}): UserIdentity =>
      identityRow({ id: 'id-cli', platform: 'cli', platform_user_id: 'rasmus', ...overrides });

    test('inserts and returns the identity row when the CLI name is unseen', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([])); // SELECT
      mockQuery.mockResolvedValueOnce(createQueryResult([cliIdentity()])); // INSERT ... RETURNING
      const identity = await linkPlatformIdentity('user-1', 'cli', 'rasmus');
      expect(identity.platform_user_id).toBe('rasmus');
      expect(mockQuery).toHaveBeenNthCalledWith(2, expect.stringContaining('RETURNING *'), [
        'user-1',
        'cli',
        'rasmus',
        null,
      ]);
    });

    test('re-linking an identity the same user already holds is a no-op', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([cliIdentity({ user_id: 'user-1' })]));
      const identity = await linkPlatformIdentity('user-1', 'cli', 'rasmus');
      expect(identity.id).toBe('id-cli');
      // Only the SELECT ran — no display name to refresh, so nothing is written.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('refuses an identity bound to a different user without touching the row', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([cliIdentity({ user_id: 'user-other' })]));
      await expect(linkPlatformIdentity('user-1', 'cli', 'rasmus')).rejects.toBeInstanceOf(
        PlatformIdentityConflictError
      );
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('recovers from a concurrent-insert race when the winner is the same user', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([])); // SELECT: not found yet
      mockQuery.mockRejectedValueOnce(
        Object.assign(new Error('UNIQUE constraint failed'), { code: '23505' })
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([cliIdentity({ user_id: 'user-1' })]));
      const identity = await linkPlatformIdentity('user-1', 'cli', 'rasmus');
      expect(identity.user_id).toBe('user-1');
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    test('race recovery surfaces a conflict when the winner is a different user', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockRejectedValueOnce(
        Object.assign(new Error('UNIQUE constraint failed'), { code: '23505' })
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([cliIdentity({ user_id: 'user-other' })]));
      await expect(linkPlatformIdentity('user-1', 'cli', 'rasmus')).rejects.toBeInstanceOf(
        PlatformIdentityConflictError
      );
    });
  });

  describe('unlinkPlatformIdentity', () => {
    test('scopes the DELETE to the holding user and reports the removal', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      await expect(unlinkPlatformIdentity('user-1', 'cli', 'rasmus')).resolves.toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM remote_agent_user_identities WHERE user_id = $1 AND platform = $2 AND platform_user_id = $3',
        ['user-1', 'cli', 'rasmus']
      );
    });

    test('returns false when the caller does not hold the binding', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
      await expect(unlinkPlatformIdentity('user-1', 'cli', 'someone-else')).resolves.toBe(false);
    });
  });

  describe('listUserIdentities', () => {
    test('selects every identity of one user, oldest first', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      const identities = await listUserIdentities('user-1');
      expect(identities).toHaveLength(1);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_user_identities WHERE user_id = $1 ORDER BY created_at ASC',
        ['user-1']
      );
    });
  });

  describe('updateUserGithubProfile', () => {
    test('COALESCEs display_name + email and passes [display_name, email, userId]', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      await updateUserGithubProfile('user-1', {
        display_name: 'Alice',
        email: 'alice@example.com',
      });
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('COALESCE($1, display_name)');
      expect(sql).toContain('COALESCE($2, email)');
      expect(params).toEqual(['Alice', 'alice@example.com', 'user-1']);
    });

    test('passes null for omitted fields so COALESCE keeps existing values', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      await updateUserGithubProfile('user-1', { email: null });
      expect(mockQuery.mock.calls[0]?.[1]).toEqual([null, null, 'user-1']);
    });
  });
});
