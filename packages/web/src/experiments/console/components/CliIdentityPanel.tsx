import { useState, type FormEvent, type ReactElement } from 'react';
import * as skill from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { HttpError } from '../lib/http';
import { SettingsSection } from './SettingsSection';

/**
 * Claim the CLI identity this operator uses in their shell, so conversations and
 * runs started with `archon` appear in their own console. `archon auth whoami`
 * prints the value to paste.
 *
 * The claim is asserted here, from the authenticated web session, and never from
 * the CLI — a CLI-side link would let anyone with shell attach themselves to a
 * web user and inherit that user's private conversations and credentials.
 *
 * `GET /api/auth/me/identities` 401s when there's no web identity (the solo
 * install, and a logged-out user on a web-auth install); we render NOTHING then,
 * because nothing is owned on such an install and there is nothing to claim.
 */
export function CliIdentityPanel(): ReactElement | null {
  const { data, error } = useEntity(K.userIdentities, skill.listIdentities);

  const [claim, setClaim] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const link = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const value = claim.trim();
    if (!value || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await skill.linkCliIdentity(value);
      setClaim('');
      invalidate(K.userIdentities);
    } catch (err: unknown) {
      // A 409 is the conflict message from the server ("already linked to a
      // different Archon user"); surface it rather than a generic failure.
      setMessage(
        err instanceof HttpError
          ? (parseApiError(err.bodySnippet) ?? err.message)
          : err instanceof Error
            ? err.message
            : 'Link failed.'
      );
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (identity: skill.LinkedIdentity): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await skill.unlinkIdentity(identity.platform, identity.platformUserId);
      invalidate(K.userIdentities);
    } catch (err: unknown) {
      setMessage(err instanceof Error ? err.message : 'Unlink failed.');
    } finally {
      setBusy(false);
    }
  };

  if (error instanceof HttpError && error.status === 401) return null;
  if (error !== undefined) {
    return (
      <SettingsSection title="CLI Identity">
        <p className="font-mono text-[11px] text-error">{error.message}</p>
      </SettingsSection>
    );
  }
  if (data === undefined) {
    return (
      <SettingsSection title="CLI Identity">
        <p className="font-mono text-[11px] text-text-tertiary">Loading…</p>
      </SettingsSection>
    );
  }

  const cliIdentities = data.identities.filter(i => i.platform === 'cli');

  return (
    <SettingsSection title="CLI Identity">
      <div className="flex flex-col gap-3 text-[12px]">
        <span className="text-text-secondary">
          Claim the identity your shell uses so conversations you start with{' '}
          <code className="font-mono text-text-primary">archon</code> show up here. Run{' '}
          <code className="font-mono text-text-primary">archon auth whoami</code> to see it.
        </span>

        {cliIdentities.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {cliIdentities.map(identity => (
              <li
                key={identity.platformUserId}
                className="flex items-center justify-between gap-3 rounded border border-border bg-surface-inset px-3 py-2"
              >
                <span className="font-mono text-text-primary">{identity.platformUserId}</span>
                <button
                  type="button"
                  onClick={() => void unlink(identity)}
                  disabled={busy}
                  className="shrink-0 rounded border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary disabled:opacity-40"
                >
                  Unlink
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <form onSubmit={e => void link(e)} className="flex items-center gap-2">
          <input
            value={claim}
            onChange={e => {
              setClaim(e.target.value);
            }}
            placeholder="CLI identity (e.g. rasmus)"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-border bg-surface-inset px-2.5 py-1 font-mono text-[11px] text-text-primary outline-none focus:border-border-bright"
          />
          <button
            type="submit"
            disabled={busy || claim.trim() === ''}
            className="brand-bar shrink-0 rounded px-3 py-0.5 text-[11px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
          >
            {busy ? 'Working…' : 'Link'}
          </button>
        </form>

        {message !== null ? <p className="font-mono text-[11px] text-error">{message}</p> : null}
      </div>
    </SettingsSection>
  );
}

/** Pull the `error` field out of an apiError body, tolerating a truncated snippet. */
function parseApiError(bodySnippet: string): string | null {
  try {
    const parsed: unknown = JSON.parse(bodySnippet);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const value = (parsed as { error: unknown }).error;
      if (typeof value === 'string') return value;
    }
  } catch {
    // Snippets are capped at ~200 chars and can be cut mid-JSON.
  }
  return null;
}
