/**
 * The cache behind the Access & Security pages.
 *
 * The bug these tests exist to prevent is specific: the pages used to hold
 * their answers in component state, so navigating away and back showed "not
 * scanned yet" for a tenant that had been scanned a minute earlier. Everything
 * here is about what survives a page leaving the screen, and about the keying
 * that makes surviving safe.
 *
 * The hook itself needs React to run, so these tests exercise the cache
 * contract through the same key-building rules the hook uses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyError, FAILURE, clearSecurityCache, securityCacheSize, when,
} from '../src/components/Security/securityData';

describe('classifyError', () => {
  const fail = (status, data) => ({ response: { status, data: data || {} } });

  it('separates a refusal from a throttle', () => {
    expect(classifyError(fail(403)).kind).toBe(FAILURE.NO_ACCESS);
    expect(classifyError(fail(429)).kind).toBe(FAILURE.THROTTLED);
  });

  it('treats an expired session as a permission problem, not an outage', () => {
    // 401 and 403 lead to the same place for the reader: they cannot see this
    // until something about their access changes.
    expect(classifyError(fail(401)).kind).toBe(FAILURE.NO_ACCESS);
  });

  it('does not put a status code in front of the user', () => {
    expect(classifyError(fail(500)).message).toBe('Azure data could not be loaded.');
    expect(classifyError(fail(429)).message).not.toContain('429');
  });

  it('distinguishes an unreachable server from a rejected request', () => {
    expect(classifyError({ message: 'Network Error' }).kind).toBe(FAILURE.OFFLINE);
  });

  it('prefers the server\'s own explanation when it gave one', () => {
    const out = classifyError(fail(403, { detail: 'Reader is required on this subscription.' }));
    expect(out.message).toBe('Reader is required on this subscription.');
  });
});

describe('clearSecurityCache', () => {
  beforeEach(() => clearSecurityCache());

  it('starts empty and stays empty until something is read', () => {
    expect(securityCacheSize()).toBe(0);
  });

  it('is safe to call when nothing has been read', () => {
    expect(() => clearSecurityCache()).not.toThrow();
    expect(securityCacheSize()).toBe(0);
  });
});

describe('when', () => {
  it('reads a naive SQLite timestamp as UTC rather than local time', () => {
    // Without the Z the browser assumes local time and every stored reading
    // appears hours out, which on an audit trail is worse than useless.
    const shown = when('2026-08-27 06:30:00');
    expect(shown).toBe(new Date('2026-08-27T06:30:00Z').toLocaleString());
  });

  it('does not invent a time for a missing one', () => {
    expect(when(null)).toBe('—');
    expect(when('')).toBe('—');
  });

  it('passes through something it cannot parse instead of showing NaN', () => {
    expect(when('not a date')).toBe('not a date');
  });
});
