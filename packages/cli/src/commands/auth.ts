/**
 * `archon auth` — CLI identity commands.
 *
 * `github` connects the current CLI user's GitHub identity via the device flow.
 * Only meaningful when per-user GitHub is enabled (GitHub App +
 * TOKEN_ENCRYPTION_KEY); solo `GITHUB_TOKEN` installs don't need it.
 *
 * `whoami` prints the identity this shell acts as, which is what a web user
 * pastes into the console to claim their CLI conversations.
 *
 * CLI identity: ARCHON_USER_ID (explicit override) else $USER/$USERNAME. We
 * resolve it to a stable Archon user via the 'cli' platform identity so the
 * connected GitHub token attaches to the same user across CLI invocations.
 *
 * On an install that enforces conversation ownership (#3135) that resolution is
 * find-only: minting a user for an unlinked shell identity would bind
 * ('cli', <name>) to an account nobody can sign in as, and the console claim
 * this whole surface exists for would then conflict forever.
 */
import { createLogger } from '@archon/paths';
import {
  isPerUserGitHubEnabled,
  connectGithubForUser,
  DeviceFlowError,
  GithubIdentityConflictError,
} from '@archon/core';
import { isConversationOwnershipEnforced } from '@archon/core/auth/config';
import * as userDb from '@archon/core/db/users';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.auth');
  return cachedLog;
}

export function resolveCliUserId(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ARCHON_USER_ID?.trim();
  if (explicit) return explicit;
  const sys = env.USER?.trim() || env.USERNAME?.trim();
  return sys || null;
}

/**
 * What the acting shell resolved to. The three failure cases are genuinely
 * different answers and callers act on them differently — attribution shrugs at
 * all three, while a command that writes a credential has to refuse `unlinked`
 * with an actionable message instead of storing it against nobody.
 */
export type CliIdentityResolution =
  /** ARCHON_USER_ID / $USER / $USERNAME resolved to an Archon user. */
  | { kind: 'resolved'; cliId: string; userId: string }
  /** No CLI identity is set at all: this shell acts as nobody. */
  | { kind: 'unset' }
  /** Enforced install: the identity is real but no Archon user has claimed it. */
  | { kind: 'unlinked'; cliId: string }
  /** The user table could not be reached. */
  | { kind: 'unavailable'; cliId: string; error: Error };

/**
 * The one definition of how a shell becomes an Archon user, so no caller spells
 * the enforcement rule a second time.
 *
 * Under conversation-ownership enforcement the lookup is find-only. Minting a
 * user for an unlinked shell identity would bind ('cli', <name>) to an account
 * nobody can sign in as, and the console claim would then conflict forever with
 * a holder that has no web session to unlink from. Solo installs keep
 * find-or-create, so per-user CLI credentials and prefs work there exactly as
 * they do today.
 *
 * Never throws: a caller decides whether an unreachable user table is fatal.
 */
export async function resolveCliIdentity(): Promise<CliIdentityResolution> {
  const cliId = resolveCliUserId();
  if (!cliId) return { kind: 'unset' };
  try {
    const cliUser = isConversationOwnershipEnforced()
      ? await userDb.findUserByPlatformIdentity('cli', cliId)
      : await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
    return cliUser ? { kind: 'resolved', cliId, userId: cliUser.id } : { kind: 'unlinked', cliId };
  } catch (error) {
    return { kind: 'unavailable', cliId, error: error as Error };
  }
}

/**
 * The one message that tells an operator how to claim their CLI identity, for
 * the commands that must refuse rather than degrade.
 */
export function unlinkedCliIdentityMessage(cliId: string): string {
  return (
    `The CLI identity '${cliId}' is not linked to an Archon user on this install.\n` +
    "Run 'archon auth whoami', claim that identity in the console under\n" +
    'Settings → CLI Identity, then run this again.'
  );
}

/** CLI identities already told they are unlinked, so a process says it once. */
const unlinkedNoticesShown = new Set<string>();

/**
 * Tell the operator once that their work will not show up in their console.
 * A notice, not a failure: the turn or run still executes, it is just written
 * without an owner — the same row a CLI invocation produced before attribution
 * existed at all.
 */
function noticeUnlinkedCliIdentity(cliId: string): void {
  if (unlinkedNoticesShown.has(cliId)) return;
  unlinkedNoticesShown.add(cliId);
  console.error(
    `Note: the CLI identity '${cliId}' is not linked to an Archon user on this install,\n` +
      'so work started here is unattributed and will not appear in your console.\n' +
      "Run 'archon auth whoami', then claim that identity in the console under\n" +
      'Settings → CLI Identity.'
  );
}

/**
 * The acting CLI user's Archon id, or undefined when no identity is set, none is
 * linked, or the user table could not be reached. Attribution is best-effort by
 * design — a chat turn or a workflow run must not fail because Archon cannot name
 * the operator.
 *
 * Shared by every CLI surface that stamps a row with the local operator (the chat
 * and workflow conversation rows, the workflow run row, the persisted user
 * message) and by the per-user reads, where "no id" and "no overrides" are the
 * same answer.
 */
export async function resolveCliUserRecordId(): Promise<string | undefined> {
  const identity = await resolveCliIdentity();
  switch (identity.kind) {
    case 'resolved':
      return identity.userId;
    case 'unlinked':
      noticeUnlinkedCliIdentity(identity.cliId);
      return undefined;
    case 'unavailable':
      getLog().warn(
        { err: identity.error, cliId: identity.cliId },
        'cli.user_identity_resolve_failed'
      );
      return undefined;
    case 'unset':
      return undefined;
  }
}

/**
 * `archon auth whoami` — print the identity this shell acts as.
 *
 * Two ids, because two surfaces consume them: the CLI identity is what a web
 * user pastes into the console to claim these conversations as theirs, and the
 * Archon user id is the durable row both surfaces resolve to. Neither is a
 * secret — verification for a link comes from holding the web session, not from
 * knowing the CLI name.
 *
 * Reading must not bind. Under enforcement this reports "not linked yet" rather
 * than creating a user, so the very command that tells you what to paste cannot
 * be the reason pasting it fails.
 */
export async function authWhoamiCommand(): Promise<number> {
  const identity = await resolveCliIdentity();

  if (identity.kind === 'unset') {
    console.error(
      'No CLI identity is set, so conversations and runs started here are unattributed.\n' +
        'Set ARCHON_USER_ID to a stable name (recommended — $USER is unset in many\n' +
        'containers and service managers, and differs between them).'
    );
    return 1;
  }
  if (identity.kind === 'unavailable') {
    getLog().error({ err: identity.error, cliId: identity.cliId }, 'cli.auth_whoami_failed');
    console.error(`Could not resolve your CLI identity: ${identity.error.message}`);
    return 1;
  }

  console.log(`CLI identity:   ${identity.cliId}`);
  if (identity.kind === 'resolved') {
    console.log(`Archon user id: ${identity.userId}`);
    console.log(
      '\nOn an install with web auth, link this CLI identity from the console\n' +
        '(Settings → CLI Identity) to see conversations started here in your own account.'
    );
  } else {
    console.log('Archon user id: not linked yet');
    console.log(
      '\nThis install keeps operator conversations private to their owner, so work\n' +
        'started here is unattributed until you claim this identity. Paste the CLI\n' +
        'identity above into the console under Settings → CLI Identity.'
    );
  }
  return 0;
}

export async function authGithubCommand(): Promise<number> {
  if (!isPerUserGitHubEnabled()) {
    console.error(
      'Per-user GitHub auth is not enabled on this install.\n' +
        'It requires the GitHub App (GITHUB_APP_ID + GITHUB_APP_CLIENT_ID) and TOKEN_ENCRYPTION_KEY.\n' +
        'Solo installs using GITHUB_TOKEN do not need to connect.'
    );
    return 1;
  }

  const identity = await resolveCliIdentity();
  if (identity.kind === 'unset') {
    console.error('Could not determine your CLI identity. Set ARCHON_USER_ID (or $USER).');
    return 1;
  }
  // A user-table failure is fatal here rather than best-effort: the device flow
  // has nothing to attach its tokens to. Surfaced by cli.ts as it was before.
  if (identity.kind === 'unavailable') throw identity.error;
  // Refuse rather than degrade: connecting stores a credential against a user,
  // and minting one for an unlinked identity would attach this GitHub account to
  // a user nobody can sign in as — and block the console claim afterwards.
  if (identity.kind === 'unlinked') {
    console.error(unlinkedCliIdentityMessage(identity.cliId));
    return 1;
  }
  console.log(`Opening device flow for user_id: ${identity.cliId}`);

  try {
    const result = await connectGithubForUser(identity.userId, info => {
      console.log(`\n→ Visit ${info.verification_uri} and enter code: ${info.user_code}`);
      console.log('→ Waiting for authorization…');
    });
    console.log(`\n✓ Connected as @${result.githubLogin}. Tokens stored encrypted in Archon's DB.`);
    return 0;
  } catch (err) {
    if (err instanceof GithubIdentityConflictError) {
      console.error(`\n✗ ${err.message}`);
    } else if (err instanceof DeviceFlowError) {
      console.error(`\n✗ Device flow failed (${err.code}): ${err.message}`);
    } else {
      getLog().error({ err: err as Error }, 'cli.auth_github_failed');
      console.error(`\n✗ Connect failed: ${(err as Error).message}`);
    }
    return 1;
  }
}
