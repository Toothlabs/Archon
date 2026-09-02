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
 */
import { createLogger } from '@archon/paths';
import {
  isPerUserGitHubEnabled,
  connectGithubForUser,
  DeviceFlowError,
  GithubIdentityConflictError,
} from '@archon/core';
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
 * The acting CLI user's Archon id, or undefined when `ARCHON_USER_ID`/`$USER` is unset
 * or the identity cannot be resolved. Attribution is best-effort by design — a chat turn
 * or a workflow run must not fail because the user table could not be reached.
 *
 * Shared by every CLI surface that stamps a row with the local operator: the chat and
 * workflow conversation rows, the workflow run row, and the persisted user message.
 */
export async function resolveCliUserRecordId(): Promise<string | undefined> {
  const cliId = resolveCliUserId();
  if (!cliId) return undefined;
  try {
    const cliUser = await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
    return cliUser.id;
  } catch (error) {
    getLog().warn({ err: error as Error, cliId }, 'cli.user_identity_resolve_failed');
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
 */
export async function authWhoamiCommand(): Promise<number> {
  const cliId = resolveCliUserId();
  if (!cliId) {
    console.error(
      'No CLI identity is set, so conversations and runs started here are unattributed.\n' +
        'Set ARCHON_USER_ID to a stable name (recommended — $USER is unset in many\n' +
        'containers and service managers, and differs between them).'
    );
    return 1;
  }

  let user: { id: string };
  try {
    user = await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
  } catch (err) {
    getLog().error({ err: err as Error, cliId }, 'cli.auth_whoami_failed');
    console.error(`Could not resolve your CLI identity: ${(err as Error).message}`);
    return 1;
  }

  console.log(`CLI identity:   ${cliId}`);
  console.log(`Archon user id: ${user.id}`);
  console.log(
    '\nOn an install with web auth, link this CLI identity from the console\n' +
      '(Settings → CLI Identity) to see conversations started here in your own account.'
  );
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

  const cliId = resolveCliUserId();
  if (!cliId) {
    console.error('Could not determine your CLI identity. Set ARCHON_USER_ID (or $USER).');
    return 1;
  }

  const user = await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
  console.log(`Opening device flow for user_id: ${cliId}`);

  try {
    const result = await connectGithubForUser(user.id, info => {
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
