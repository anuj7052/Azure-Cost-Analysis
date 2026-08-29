/**
 * Reading API errors.
 *
 * The rule under test is the one the whole platform rests on: a failure is
 * never a number. If Azure throttles or refuses a read, the UI must be told to
 * show a state, not a value — because a rendered 0 looks like a real answer and
 * somebody will act on it.
 */
import { describe, it, expect } from 'vitest';
import {
  DataState,
  ErrorCode,
  dataStateLabel,
  errorCode,
  errorDataState,
  errorDetail,
  errorMessage,
  errorRequestId,
  isInconclusive,
  isRetryable,
  friendlyError,
  placeholderForState,
  retryAfterSeconds,
} from '../src/utils/apiError';

/** An error shaped the way axios delivers one. */
const apiError = (status, data, headers = {}) => ({
  response: { status, data, headers },
  message: 'Request failed',
});

const enveloped = (code, message, detail = {}, requestId = 'req-1') =>
  apiError(400, { error: { code, message, detail, request_id: requestId } });

describe('reading the error envelope', () => {
  it('reads the code, message, detail and request id', () => {
    const err = enveloped(
      ErrorCode.AZURE_THROTTLED,
      'Azure is rate limiting this account.',
      { retry_after_seconds: 12 },
      'req-abc',
    );

    expect(errorCode(err)).toBe('azure_throttled');
    expect(errorMessage(err)).toBe('Azure is rate limiting this account.');
    expect(errorDetail(err).retry_after_seconds).toBe(12);
    expect(errorRequestId(err)).toBe('req-abc');
  });

  it('still reads the legacy FastAPI detail string', () => {
    // The unversioned /api surface remains live for the existing frontend, so
    // both shapes have to keep working during the migration.
    expect(errorMessage(apiError(403, { detail: 'You do not have access to this tenant.' })))
      .toBe('You do not have access to this tenant.');
  });

  it('reads a validation error list', () => {
    const err = apiError(422, { detail: [{ msg: 'field required', loc: ['body', 'tenant_id'] }] });

    expect(errorMessage(err)).toBe('field required');
  });

  it('never returns undefined for an unrecognised failure', () => {
    // A blank error box tells the user nothing and looks like a rendering bug.
    expect(errorMessage({})).toBeTruthy();
    expect(errorMessage(apiError(500, {}))).toBeTruthy();
    expect(errorMessage(null)).toBeTruthy();
  });
});

describe('data states', () => {
  it.each([
    DataState.UNAVAILABLE,
    DataState.PERMISSION_REQUIRED,
    DataState.THROTTLED,
    DataState.UNKNOWN,
  ])('%s carries no value', (state) => {
    expect(isInconclusive(state)).toBe(true);
    expect(placeholderForState(state)).toBeTruthy();
  });

  it.each([
    DataState.CONFIRMED,
    DataState.ESTIMATED,
    DataState.STALE,
    DataState.HISTORICAL,
  ])('%s does carry a value', (state) => {
    expect(isInconclusive(state)).toBe(false);
    // null means "render the real number".
    expect(placeholderForState(state)).toBeNull();
  });

  it('labels every state with something readable', () => {
    Object.values(DataState).forEach((state) => {
      expect(dataStateLabel(state)).not.toMatch(/^\s*$/);
    });
  });
});

describe('classifying failures into a display state', () => {
  it('maps throttling to Throttled, never to a value', () => {
    const err = enveloped(ErrorCode.AZURE_THROTTLED, 'Slow down', {
      retry_after_seconds: 9,
      data_state: DataState.THROTTLED,
    });

    expect(errorDataState(err)).toBe(DataState.THROTTLED);
    expect(placeholderForState(errorDataState(err))).toBe('Throttled');
  });

  it('maps a refused read to Permission required, not to an empty result', () => {
    // Telling a customer their estate is clean when we were simply refused the
    // read is the security-relevant version of this bug.
    const err = enveloped(ErrorCode.AZURE_PERMISSION_REQUIRED, 'Refused', {
      required_role: 'Security Reader',
      data_state: DataState.PERMISSION_REQUIRED,
    });

    expect(errorDataState(err)).toBe(DataState.PERMISSION_REQUIRED);
    expect(placeholderForState(errorDataState(err))).toBe('Permission required');
  });

  it('maps an Azure outage to Unavailable', () => {
    const err = enveloped(ErrorCode.AZURE_UNAVAILABLE, 'Gateway error');

    expect(errorDataState(err)).toBe(DataState.UNAVAILABLE);
  });

  it('maps our own rate limit to Throttled', () => {
    expect(errorDataState(enveloped(ErrorCode.RATE_LIMITED, 'Too many'))).toBe(DataState.THROTTLED);
  });

  it('treats a failure with no response as Unknown rather than assuming zero', () => {
    expect(errorDataState({ message: 'Network Error' })).toBe(DataState.UNKNOWN);
  });

  it('never classifies a failure as Confirmed', () => {
    const failures = [
      enveloped(ErrorCode.AZURE_THROTTLED, 'x'),
      enveloped(ErrorCode.AZURE_UNAVAILABLE, 'x'),
      enveloped(ErrorCode.INTERNAL_ERROR, 'x'),
      apiError(500, {}),
      { message: 'Network Error' },
    ];

    failures.forEach((err) => {
      expect(errorDataState(err)).not.toBe(DataState.CONFIRMED);
      expect(isInconclusive(errorDataState(err))).toBe(true);
    });
  });
});

describe('retry guidance', () => {
  it('marks transient failures as retryable', () => {
    expect(isRetryable(enveloped(ErrorCode.AZURE_THROTTLED, 'x'))).toBe(true);
    expect(isRetryable(enveloped(ErrorCode.RATE_LIMITED, 'x'))).toBe(true);
    expect(isRetryable(enveloped(ErrorCode.AZURE_UNAVAILABLE, 'x'))).toBe(true);
  });

  it('does not invite a retry that cannot succeed', () => {
    // Retrying a missing role just produces the same 403 and hides the fix.
    expect(isRetryable(enveloped(ErrorCode.AZURE_PERMISSION_REQUIRED, 'x'))).toBe(false);
    expect(isRetryable(enveloped(ErrorCode.VALIDATION_FAILED, 'x'))).toBe(false);
    expect(isRetryable(enveloped(ErrorCode.NOT_FOUND, 'x'))).toBe(false);
  });

  it('prefers the Retry-After header over the payload', () => {
    const err = apiError(
      429,
      { error: { code: ErrorCode.RATE_LIMITED, message: 'x', detail: { retry_after_seconds: 5 } } },
      { 'retry-after': '30' },
    );

    expect(retryAfterSeconds(err)).toBe(30);
  });

  it('falls back to the payload when there is no header', () => {
    expect(retryAfterSeconds(enveloped(ErrorCode.RATE_LIMITED, 'x', { retry_after_seconds: 7 })))
      .toBe(7);
  });

  it('reports 0 when the wait is unknown rather than guessing', () => {
    expect(retryAfterSeconds(apiError(500, {}))).toBe(0);
  });
});

describe('a setup step the user has to take', () => {
  // The assistant refuses with 409 when the account has no model endpoint of
  // its own. That message is written to be read: it names the screen, says who
  // is billed, and says the rest of the app still works. Replacing it with our
  // own generic wording would throw all three away, so 409 must fall through
  // to the server's own sentence.
  const missingEndpoint = {
    response: {
      status: 409,
      data: {
        detail:
          'The assistant needs a model endpoint of your own. Add one under '
          + 'Settings → Integrations: an Azure OpenAI or OpenAI endpoint, its key, '
          + 'and a daily request limit. Requests are sent to your endpoint and '
          + 'billed to your account, so nothing here is charged to anyone else. '
          + 'The rest of the app works without this.',
      },
    },
  };

  it('shows the explanation the server wrote', () => {
    expect(friendlyError(missingEndpoint)).toContain('Settings → Integrations');
  });

  it('keeps the part that says who pays', () => {
    expect(friendlyError(missingEndpoint)).toContain('billed to your account');
  });

  it('does not present a setup step as a fault', () => {
    expect(friendlyError(missingEndpoint)).not.toContain('went wrong');
    expect(friendlyError(missingEndpoint)).not.toContain('try again');
  });
});
