/**
 * Azure's own error text is written for whoever wrote the API call, not for
 * whoever has to decide what to do next. These tests pin the translation.
 */
import { describe, it, expect } from 'vitest';
import { friendlyError } from '../src/utils/apiError';

const fail = (status, data) => ({ response: { status, data: data || {} } });

describe('friendlyError', () => {
  it('turns a throttle into an instruction to wait', () => {
    const msg = friendlyError(fail(429));
    expect(msg).toContain('temporarily limiting requests');
    expect(msg).not.toContain('429');
  });

  it('quotes the wait Azure asked for when it gave one', () => {
    const msg = friendlyError(fail(429, {
      error: { code: 'azure_throttled', detail: { retry_after_seconds: 30 } },
    }));
    expect(msg).toContain('30 seconds');
  });

  it('names the missing role rather than the refused action', () => {
    const msg = friendlyError(fail(403, {
      error: { code: 'forbidden', detail: { required_role: 'User Access Administrator' } },
    }));
    expect(msg).toContain('User Access Administrator');
    expect(msg).not.toContain('403');
  });

  it('tells an expired session to sign in again', () => {
    expect(friendlyError(fail(401))).toContain('Sign in again');
  });

  it('does not leak a status code or a stack for a server fault', () => {
    const msg = friendlyError(fail(500, { detail: 'Traceback (most recent call last)' }));
    expect(msg).toBe("We couldn't complete this right now. Please try again.");
    expect(msg).not.toContain('Traceback');
  });

  it('separates an unreachable service from a rejected request', () => {
    expect(friendlyError({ message: 'Network Error' })).toContain('could not reach');
  });

  it('prefers a considered message from our own API', () => {
    const msg = friendlyError(fail(400, {
      error: { code: 'validation_failed', message: 'Pick at least one subscription.' },
    }));
    expect(msg).toBe('Pick at least one subscription.');
  });
});
