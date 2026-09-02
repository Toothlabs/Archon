/**
 * Pure env predicates describing what kind of install this is.
 *
 * These live in core rather than in the server because both the server and the
 * CLI have to agree on the answer: the server decides whether a conversation is
 * private to its owner, and the CLI decides whether it may mint an Archon user
 * for an unlinked shell identity. Two copies of the rule would drift, and a
 * drifted copy here is a privacy bug.
 *
 * Deliberately dependency-free (no pg, no Better Auth, no logger) and taking the
 * environment as an argument, so both are unit-testable by passing an object
 * literal without mutating `process.env`.
 */

/**
 * Web auth is active only when a Postgres connection AND a signing secret are
 * configured. SQLite installs (no DATABASE_URL) are always opted out — Better
 * Auth's tables are Postgres-only here.
 */
export function isWebAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DATABASE_URL && env.BETTER_AUTH_SECRET);
}

/**
 * Whether operator conversations are private to their owning user (#3135).
 *
 * True on any install where identity actually arrives: Better Auth configured,
 * or a reverse proxy explicitly supplying it through `ARCHON_WEB_AUTH_HEADER`.
 * That second door matters — a proxy-authenticated install has real distinct
 * users but no Better Auth, and `isApiGateEnabled` is additionally off there
 * whenever the proxy owns admission (`ARCHON_WEB_AUTH_REQUIRED=false`).
 *
 * Keys on the variable being SET, not on the default header name, which is
 * honored even when unset — an operator setting it is the multi-user signal.
 * False on solo/SQLite installs (no Postgres, no header): nothing is owned, so
 * nothing is refused and today's open behavior is correct.
 */
export function isConversationOwnershipEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return isWebAuthEnabled(env) || Boolean(env.ARCHON_WEB_AUTH_HEADER);
}
