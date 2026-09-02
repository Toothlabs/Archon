/**
 * Tests for the CLI chat command
 */
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';

// Mock logger before any imports
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Mock @archon/core/db/messages (used by CLIAdapter for persistence)
mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(() => Promise.resolve()),
}));

// Mock handleMessage from @archon/core
const mockHandleMessage = mock(() => Promise.resolve());

mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
}));

// The `cli` platform identity upsert behind resolveCliUserRecordId().
const mockFindOrCreateUser = mock(async (_platform: string, _platformUserId: string) => ({
  id: 'user-cli-1',
}));
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mockFindOrCreateUser,
}));

import { chatCommand } from './chat';
import { CLIAdapter } from '../adapters/cli-adapter';

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

describe('chatCommand', () => {
  let savedIdentityEnv: Record<string, string | undefined>;

  beforeEach(() => {
    mockHandleMessage.mockClear();
    mockFindOrCreateUser.mockClear();
    savedIdentityEnv = snapshotIdentityEnv();
    // Deterministic operator for the default case; the attribution tests below
    // override it. Without this, the result depends on the shell running tests.
    process.env.ARCHON_USER_ID = 'cli-tester';
  });

  afterEach(() => {
    restoreIdentityEnv(savedIdentityEnv);
  });

  test('should call handleMessage with a CLIAdapter, unique conversationId, and the message', async () => {
    await chatCommand('Hello, agent!');

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);

    const [adapter, conversationId, message] = mockHandleMessage.mock.calls[0] as [
      CLIAdapter,
      string,
      string,
    ];

    expect(adapter).toBeInstanceOf(CLIAdapter);
    expect(conversationId).toMatch(/^cli-chat-\d+-[a-z0-9]+$/);
    expect(message).toBe('Hello, agent!');
  });

  test('should use batch streaming mode for the CLIAdapter', async () => {
    await chatCommand('test');

    const [adapter] = mockHandleMessage.mock.calls[0] as [CLIAdapter, string, string];
    expect(adapter.getStreamingMode()).toBe('batch');
  });

  test('should generate a unique conversationId for each invocation', async () => {
    await chatCommand('first message');
    await chatCommand('second message');

    const [, id1] = mockHandleMessage.mock.calls[0] as [unknown, string, string];
    const [, id2] = mockHandleMessage.mock.calls[1] as [unknown, string, string];

    expect(id1).not.toBe(id2);
  });

  test('should forward the exact message string to handleMessage', async () => {
    const complexMessage = '/workflow run assist "build a feature"';
    await chatCommand(complexMessage);

    const [, , message] = mockHandleMessage.mock.calls[0] as [unknown, string, string];
    expect(message).toBe(complexMessage);
  });

  test('should propagate errors thrown by handleMessage', async () => {
    mockHandleMessage.mockRejectedValueOnce(new Error('Orchestrator unavailable'));

    await expect(chatCommand('will fail')).rejects.toThrow('Orchestrator unavailable');
  });

  test('should have conversationId prefixed with cli-chat-', async () => {
    await chatCommand('prefix check');

    const [, conversationId] = mockHandleMessage.mock.calls[0] as [unknown, string, string];
    expect(conversationId.startsWith('cli-chat-')).toBe(true);
  });

  test('CLIAdapter passed to handleMessage should have cli platform type', async () => {
    await chatCommand('platform type check');

    const [adapter] = mockHandleMessage.mock.calls[0] as [CLIAdapter, string, string];
    expect(adapter.getPlatformType()).toBe('cli');
  });

  test('should not log to console for empty string message', async () => {
    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await chatCommand('');
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // #3135: a `cli` conversation row with no user_id is reachable by nobody on an
  // install that enforces conversation ownership, so the operator has to ride along.
  describe('operator attribution', () => {
    test('attributes the conversation to the resolved CLI operator', async () => {
      process.env.ARCHON_USER_ID = 'rasmus';

      await chatCommand('hello');

      expect(mockFindOrCreateUser).toHaveBeenCalledWith('cli', 'rasmus', 'rasmus');
      const [, , , context] = mockHandleMessage.mock.calls[0] as [
        unknown,
        string,
        string,
        { userId?: string },
      ];
      expect(context).toEqual({ userId: 'user-cli-1' });
    });

    test('leaves the conversation unattributed when no CLI identity resolves', async () => {
      for (const key of IDENTITY_ENV_KEYS) delete process.env[key];

      await chatCommand('hello');

      expect(mockFindOrCreateUser).not.toHaveBeenCalled();
      const [, , , context] = mockHandleMessage.mock.calls[0] as [
        unknown,
        string,
        string,
        { userId?: string },
      ];
      expect(context).toEqual({ userId: undefined });
    });

    test('a user-table failure still sends the turn, unattributed', async () => {
      mockFindOrCreateUser.mockRejectedValueOnce(new Error('db gone'));

      await chatCommand('hello');

      const [, , , context] = mockHandleMessage.mock.calls[0] as [
        unknown,
        string,
        string,
        { userId?: string },
      ];
      expect(context).toEqual({ userId: undefined });
    });
  });
});
