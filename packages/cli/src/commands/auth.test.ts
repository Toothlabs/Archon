/**
 * Tests for the CLI identity surface: `archon auth whoami` (the id a web user
 * pastes into the console to claim their CLI conversations) and
 * `resolveCliUserRecordId` (what every attributed CLI row resolves through).
 *
 * The enforcement predicate is pure and reads `process.env`, so the tests set
 * the env rather than mocking it — and pin it in `beforeEach`, because a
 * developer `.env` carrying DATABASE_URL would otherwise flip the branch.
 *
 * Mocks precede the import of ./auth.
 */
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';

const noopLogger = () => ({
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
});

mock.module('@archon/paths', () => ({ createLogger: noopLogger }));

// authGithubCommand's dependencies; whoami touches none of them, but the module
// imports them at load time.
mock.module('@archon/core', () => ({
  isPerUserGitHubEnabled: () => false,
  connectGithubForUser: mock(async () => ({ githubLogin: 'octocat' })),
  DeviceFlowError: class DeviceFlowError extends Error {},
  GithubIdentityConflictError: class GithubIdentityConflictError extends Error {},
}));

const mockFindOrCreateUser = mock(async (_platform: string, platformUserId: string) => ({
  id: `user-${platformUserId}`,
}));
/** Find-only: null until a test says this identity is linked. */
const mockFindUser = mock(
  async (_platform: string, _platformUserId: string): Promise<{ id: string } | null> => null
);
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mockFindOrCreateUser,
  findUserByPlatformIdentity: mockFindUser,
}));

import {
  authWhoamiCommand,
  resolveCliIdentity,
  resolveCliUserId,
  resolveCliUserRecordId,
  unlinkedCliIdentityMessage,
} from './auth';

/**
 * Every env key the identity path reads: the three CLI identity sources plus the
 * two that decide whether ownership is enforced.
 */
const IDENTITY_ENV_KEYS = [
  'ARCHON_USER_ID',
  'USER',
  'USERNAME',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'ARCHON_WEB_AUTH_HEADER',
] as const;

/** Turn ownership enforcement on through the proxy-header door. */
function enforceOwnership(): void {
  process.env.ARCHON_WEB_AUTH_HEADER = 'X-Archon-User';
}

/** Clear every env key the identity path reads (the solo-install baseline). */
function clearIdentityEnv(): void {
  for (const key of IDENTITY_ENV_KEYS) delete process.env[key];
}

function snapshotIdentityEnv(): Record<string, string | undefined> {
  return Object.fromEntries(IDENTITY_ENV_KEYS.map(key => [key, process.env[key]]));
}

function restoreIdentityEnv(saved: Record<string, string | undefined>): void {
  for (const key of IDENTITY_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('resolveCliUserId', () => {
  test('prefers ARCHON_USER_ID over the shell user', () => {
    expect(resolveCliUserId({ ARCHON_USER_ID: 'rasmus', USER: 'root' })).toBe('rasmus');
  });

  test('falls back to $USER then $USERNAME, and null when neither is set', () => {
    expect(resolveCliUserId({ USER: 'rasmus' })).toBe('rasmus');
    expect(resolveCliUserId({ USERNAME: 'rasmus' })).toBe('rasmus');
    expect(resolveCliUserId({})).toBeNull();
  });
});

/**
 * The one definition of how a shell becomes an Archon user. Every CLI surface
 * that needs an operator goes through this, so the four outcomes are asserted
 * here rather than re-tested at each call site.
 */
describe('resolveCliIdentity', () => {
  let savedIdentityEnv: Record<string, string | undefined>;

  beforeEach(() => {
    mockFindOrCreateUser.mockClear();
    mockFindUser.mockClear();
    savedIdentityEnv = snapshotIdentityEnv();
    clearIdentityEnv();
  });

  afterEach(() => {
    restoreIdentityEnv(savedIdentityEnv);
  });

  test("'unset' when the shell has no identity at all", async () => {
    expect(await resolveCliIdentity()).toEqual({ kind: 'unset' });
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockFindUser).not.toHaveBeenCalled();
  });

  test("'resolved' through find-or-create on a solo install", async () => {
    process.env.ARCHON_USER_ID = 'solo-op';

    expect(await resolveCliIdentity()).toEqual({
      kind: 'resolved',
      cliId: 'solo-op',
      userId: 'user-solo-op',
    });
    expect(mockFindUser).not.toHaveBeenCalled();
  });

  test("'unlinked' under enforcement, without minting a user", async () => {
    process.env.ARCHON_USER_ID = 'unlinked-op';
    enforceOwnership();

    expect(await resolveCliIdentity()).toEqual({ kind: 'unlinked', cliId: 'unlinked-op' });
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockFindUser).toHaveBeenCalledWith('cli', 'unlinked-op');
  });

  test("'resolved' under enforcement once the identity is claimed", async () => {
    process.env.ARCHON_USER_ID = 'linked-op';
    enforceOwnership();
    mockFindUser.mockResolvedValueOnce({ id: 'web-user-1' });

    expect(await resolveCliIdentity()).toEqual({
      kind: 'resolved',
      cliId: 'linked-op',
      userId: 'web-user-1',
    });
  });

  // Never throws: each caller decides whether an unreachable user table is fatal.
  test("'unavailable' carries the error instead of raising", async () => {
    process.env.ARCHON_USER_ID = 'solo-op';
    const failure = new Error('db gone');
    mockFindOrCreateUser.mockRejectedValueOnce(failure);

    expect(await resolveCliIdentity()).toEqual({
      kind: 'unavailable',
      cliId: 'solo-op',
      error: failure,
    });
  });
});

describe('unlinkedCliIdentityMessage', () => {
  test('names the identity and the console panel that claims it', () => {
    const message = unlinkedCliIdentityMessage('rasmus');
    expect(message).toContain('rasmus');
    expect(message).toContain('archon auth whoami');
    expect(message).toContain('Settings → CLI Identity');
  });
});

describe('authWhoamiCommand', () => {
  let savedIdentityEnv: Record<string, string | undefined>;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockFindOrCreateUser.mockClear();
    mockFindUser.mockClear();
    savedIdentityEnv = snapshotIdentityEnv();
    clearIdentityEnv();
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreIdentityEnv(savedIdentityEnv);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('prints the CLI identity and the Archon user id it resolves to', async () => {
    process.env.ARCHON_USER_ID = 'rasmus';
    const code = await authWhoamiCommand();
    expect(code).toBe(0);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('cli', 'rasmus', 'rasmus');
    const printed = logSpy.mock.calls.map(args => String(args[0])).join('\n');
    expect(printed).toContain('rasmus');
    expect(printed).toContain('user-rasmus');
  });

  // Reading must not bind: the command that tells you what to paste cannot be
  // the reason pasting it 409s.
  test('under enforcement it looks the identity up without creating one', async () => {
    process.env.ARCHON_USER_ID = 'rasmus';
    enforceOwnership();

    const code = await authWhoamiCommand();

    expect(code).toBe(0);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockFindUser).toHaveBeenCalledWith('cli', 'rasmus');
    const printed = logSpy.mock.calls.map(args => String(args[0])).join('\n');
    expect(printed).toContain('rasmus');
    expect(printed).toContain('not linked yet');
    expect(printed).toContain('Settings → CLI Identity');
  });

  test('under enforcement a linked identity prints the user it resolves to', async () => {
    process.env.ARCHON_USER_ID = 'rasmus';
    enforceOwnership();
    mockFindUser.mockResolvedValueOnce({ id: 'web-user-1' });

    const code = await authWhoamiCommand();

    expect(code).toBe(0);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map(args => String(args[0])).join('\n');
    expect(printed).toContain('web-user-1');
    expect(printed).not.toContain('not linked yet');
  });

  test('with no identity set, explains the gap and points at ARCHON_USER_ID', async () => {
    const code = await authWhoamiCommand();
    expect(code).toBe(1);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('ARCHON_USER_ID');
  });

  test('reports a failed identity lookup instead of printing a half-answer', async () => {
    process.env.ARCHON_USER_ID = 'rasmus';
    mockFindOrCreateUser.mockRejectedValueOnce(new Error('connection reset'));
    const code = await authWhoamiCommand();
    expect(code).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('connection reset');
  });
});

/**
 * #3135 Phase 6b: under enforcement an unlinked shell must not mint its own
 * Archon user — that user would hold ('cli', <name>) against the console claim
 * and only the database could release it. Each enforced case uses its own
 * identity because the "not linked" notice is printed once per identity.
 */
describe('resolveCliUserRecordId', () => {
  let savedIdentityEnv: Record<string, string | undefined>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockFindOrCreateUser.mockClear();
    mockFindUser.mockClear();
    savedIdentityEnv = snapshotIdentityEnv();
    clearIdentityEnv();
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreIdentityEnv(savedIdentityEnv);
    errorSpy.mockRestore();
  });

  test('creates the CLI user on a solo install, exactly as before', async () => {
    process.env.ARCHON_USER_ID = 'solo-op';

    expect(await resolveCliUserRecordId()).toBe('user-solo-op');
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('cli', 'solo-op', 'solo-op');
    expect(mockFindUser).not.toHaveBeenCalled();
  });

  test('under enforcement an unlinked identity resolves to nobody and says so', async () => {
    process.env.ARCHON_USER_ID = 'unlinked-op';
    enforceOwnership();

    expect(await resolveCliUserRecordId()).toBeUndefined();
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockFindUser).toHaveBeenCalledWith('cli', 'unlinked-op');
    const notice = errorSpy.mock.calls.map(args => String(args[0])).join('\n');
    expect(notice).toContain('unlinked-op');
    expect(notice).toContain('archon auth whoami');
  });

  test('the unlinked notice is printed once per identity, not once per call', async () => {
    process.env.ARCHON_USER_ID = 'noisy-op';
    enforceOwnership();

    await resolveCliUserRecordId();
    await resolveCliUserRecordId();

    expect(mockFindUser).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('under enforcement a linked identity resolves to the user holding it', async () => {
    process.env.ARCHON_USER_ID = 'linked-op';
    enforceOwnership();
    mockFindUser.mockResolvedValueOnce({ id: 'web-user-1' });

    expect(await resolveCliUserRecordId()).toBe('web-user-1');
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('no CLI identity resolves to nobody without touching the user table', async () => {
    expect(await resolveCliUserRecordId()).toBeUndefined();
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockFindUser).not.toHaveBeenCalled();
  });

  test('a user-table failure degrades to unattributed rather than throwing', async () => {
    process.env.ARCHON_USER_ID = 'solo-op';
    mockFindOrCreateUser.mockRejectedValueOnce(new Error('db gone'));

    expect(await resolveCliUserRecordId()).toBeUndefined();
  });
});
