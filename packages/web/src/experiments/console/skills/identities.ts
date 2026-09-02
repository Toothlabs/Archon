import { requestJson } from '../lib/http';

/**
 * Platform identities linked to the calling web user. `listIdentities` 401s when
 * there's no web identity (no Better Auth session and no X-Archon-User) — the
 * solo-install state — which the panel reads as "hide".
 *
 * Every verb targets the caller's own user; the server never accepts a user id
 * from the request. That is the direction of trust: the web session asserts
 * "this CLI name is me", never the other way round.
 *
 * Response types are inlined (mirroring `server/.../auth.schemas.ts`) because
 * `@/lib/api` is eslint-blocked for the console.
 */

export interface LinkedIdentity {
  platform: string;
  platformUserId: string;
  displayName: string | null;
  linkedAt: string;
}

export function listIdentities(): Promise<{ identities: LinkedIdentity[] }> {
  return requestJson<{ identities: LinkedIdentity[] }>('/api/auth/me/identities');
}

/** Claim a CLI identity (the name `archon auth whoami` prints) for the caller. */
export function linkCliIdentity(platformUserId: string): Promise<{ identity: LinkedIdentity }> {
  return requestJson<{ identity: LinkedIdentity }>('/api/auth/me/identities', {
    method: 'POST',
    body: JSON.stringify({ platform: 'cli', platformUserId }),
  });
}

export function unlinkIdentity(
  platform: string,
  platformUserId: string
): Promise<{ success: boolean }> {
  return requestJson<{ success: boolean }>(
    `/api/auth/me/identities/${encodeURIComponent(platform)}/${encodeURIComponent(platformUserId)}`,
    { method: 'DELETE' }
  );
}
