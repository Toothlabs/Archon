/**
 * Tests for `archon auth whoami` — the id a web user pastes into the console to
 * claim their CLI conversations. Mocks precede the import of ./auth.
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
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mockFindOrCreateUser,
}));

import { authWhoamiCommand, resolveCliUserId } from './auth';

/** Every CLI identity source, saved so a test can clear them and put them back. */
const IDENTITY_ENV_KEYS = ['ARCHON_USER_ID', 'USER', 'USERNAME'] as const;

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

describe('authWhoamiCommand', () => {
  let savedIdentityEnv: Record<string, string | undefined>;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockFindOrCreateUser.mockClear();
    savedIdentityEnv = snapshotIdentityEnv();
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

  test('with no identity set, explains the gap and points at ARCHON_USER_ID', async () => {
    for (const key of IDENTITY_ENV_KEYS) delete process.env[key];
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
