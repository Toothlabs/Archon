/**
 * Zod schemas for the auth endpoints (web-auth status + GitHub device flow).
 */
import { z } from '@hono/zod-openapi';

/**
 * GET /api/auth/status response — drives the web UI's login gate. `enabled`
 * reflects whether Better Auth web login is mounted; `signup` reports whether
 * new accounts are invite-gated (`allowlist`), open, or off (`disabled`). No
 * auth required.
 */
export const authStatusResponseSchema = z
  .object({
    enabled: z.boolean(),
    signup: z.enum(['allowlist', 'open', 'disabled']),
  })
  .openapi('AuthStatusResponse');

/** POST /api/auth/github/device/start response — codes shown to the user. */
export const deviceStartResponseSchema = z
  .object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri: z.string(),
    interval: z.number(),
    expires_in: z.number(),
  })
  .openapi('GithubDeviceStartResponse');

/** POST /api/auth/github/device/poll request — echoes the device_code from start. */
export const devicePollBodySchema = z
  .object({ device_code: z.string().min(1) })
  .openapi('GithubDevicePollBody');

/** POST /api/auth/github/device/poll response. */
export const devicePollResponseSchema = z
  .object({
    status: z.enum(['pending', 'connected', 'expired', 'denied', 'error']),
    githubLogin: z.string().optional(),
    detail: z.string().optional(),
  })
  .openapi('GithubDevicePollResponse');

/** GET /api/auth/github response — current connection status. */
export const githubConnectionStatusSchema = z
  .object({
    connected: z.boolean(),
    githubLogin: z.string().nullable(),
  })
  .openapi('GithubConnectionStatus');

/** DELETE /api/auth/github response. */
export const githubDisconnectResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('GithubDisconnectResponse');

/**
 * Platforms a web user may claim for themselves from the console.
 *
 * Only `cli` today, and the narrowness is the point. Linking a chat or forge
 * identity needs a verified flow started from that platform's side, and `web`
 * is the identity that authenticates the caller — letting them unlink it would
 * strand the account and everything owned by it.
 */
export const LINKABLE_IDENTITY_PLATFORMS = ['cli'] as const;

export const linkableIdentityPlatformSchema = z.enum(LINKABLE_IDENTITY_PLATFORMS);

/**
 * One platform identity bound to the calling user. `linkedAt` is the row's
 * creation timestamp, passed through the shared Date→ISO transform (SQLite
 * returns its own string form).
 */
export const userIdentitySchema = z
  .object({
    platform: z.string(),
    platformUserId: z.string(),
    displayName: z.string().nullable(),
    linkedAt: z.string(),
  })
  .openapi('UserIdentity');

/** GET /api/auth/me/identities response — every identity of the calling user. */
export const userIdentityListResponseSchema = z
  .object({ identities: z.array(userIdentitySchema) })
  .openapi('UserIdentityListResponse');

/**
 * POST /api/auth/me/identities request. The endpoint can only ever bind to the
 * requesting session's own user, which is what makes holding the web session
 * the verification step — no pending-token table, TTL, or device flow needed.
 */
export const linkIdentityBodySchema = z
  .object({
    platform: linkableIdentityPlatformSchema,
    platformUserId: z.string().min(1).max(255),
  })
  .strict()
  .openapi('LinkIdentityBody');

/** POST /api/auth/me/identities response. */
export const linkIdentityResponseSchema = z
  .object({ identity: userIdentitySchema })
  .openapi('LinkIdentityResponse');

/** DELETE /api/auth/me/identities/:platform/:platformUserId path params. */
export const identityParamsSchema = z.object({
  platform: linkableIdentityPlatformSchema,
  platformUserId: z.string().min(1),
});

/** DELETE /api/auth/me/identities/:platform/:platformUserId response. */
export const unlinkIdentityResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('UnlinkIdentityResponse');
