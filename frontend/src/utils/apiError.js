/**
 * Reading errors returned by the API.
 *
 * The backend now wraps every failure in a single envelope:
 *
 *   { error: { code, message, detail, request_id } }
 *
 * but it also still serves the legacy `/api` surface, and FastAPI's own
 * validation failures use `{ detail: ... }`. Rather than teach every component
 * about all three shapes, they all read through here.
 *
 * The important rule this file exists to support: a failure is never a number.
 * When Azure throttles or refuses a read, the page must say so — showing 0
 * would look like a real answer, and somebody would act on it.
 */

/** Stable codes emitted by the backend. Mirrors `core/errors.py:ErrorCode`. */
export const ErrorCode = {
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VALIDATION_FAILED: 'validation_failed',
  RATE_LIMITED: 'rate_limited',
  AZURE_THROTTLED: 'azure_throttled',
  AZURE_PERMISSION_REQUIRED: 'azure_permission_required',
  AZURE_UNAVAILABLE: 'azure_unavailable',
  PLAN_LIMIT_REACHED: 'plan_limit_reached',
  INTERNAL_ERROR: 'internal_error',
};

/** How much a displayed value can be trusted. Mirrors `core/errors.py:DataState`. */
export const DataState = {
  CONFIRMED: 'confirmed',
  ESTIMATED: 'estimated',
  STALE: 'stale',
  HISTORICAL: 'historical',
  UNAVAILABLE: 'unavailable',
  PERMISSION_REQUIRED: 'permission_required',
  THROTTLED: 'throttled',
  UNKNOWN: 'unknown',
};

/** States that carry no value at all. Rendering a number for these is a bug. */
const INCONCLUSIVE = new Set([
  DataState.UNAVAILABLE,
  DataState.PERMISSION_REQUIRED,
  DataState.THROTTLED,
  DataState.UNKNOWN,
]);

export const isInconclusive = (state) => INCONCLUSIVE.has(state);

const body = (err) => err?.response?.data ?? {};

/** The machine-readable cause, or '' when the failure has no envelope. */
export function errorCode(err) {
  return body(err).error?.code || '';
}

/** Structured extras: retry_after_seconds, required_role, data_state. */
export function errorDetail(err) {
  return body(err).error?.detail || {};
}

/**
 * A message worth showing a user.
 *
 * Falls back through the legacy shapes so a component works against either API
 * surface, and finally to a generic line — never to `undefined`, which renders
 * as a blank error box that tells the user nothing.
 */
export function errorMessage(err) {
  const data = body(err);

  if (data.error?.message) return data.error.message;
  if (typeof data.detail === 'string') return data.detail;
  if (Array.isArray(data.detail) && data.detail[0]?.msg) return data.detail[0].msg;
  if (err?.message) return err.message;

  return 'Something went wrong. Please try again.';
}

/** The request id, for a user to quote when reporting a problem. */
export const errorRequestId = (err) => body(err).error?.request_id || '';

/**
 * The same failure, said in a sentence rather than a status code.
 *
 * `errorMessage` returns whatever the server sent, which is right for
 * diagnostics and wrong for a dialog: Azure's own wording runs to things like
 * "The client 'x' with object id 'y' does not have authorization to perform
 * action 'Microsoft.Authorization/roleAssignments/write' over scope '/…'".
 * That is precise, useful to an engineer, and unreadable to the person being
 * asked to approve something.
 *
 * Status codes are mapped rather than passed through because each one implies a
 * different next step, and the next step is the only part the reader needs:
 * wait, ask for a permission, sign in, or try again. The server's own message
 * is preferred where it exists and reads like prose -- our own copy is a
 * fallback for the raw ones, never a replacement for a considered explanation.
 */
export function friendlyError(err) {
  const status = err?.response?.status;
  const code = errorCode(err);

  if (status === 429 || code === ErrorCode.AZURE_THROTTLED || code === ErrorCode.RATE_LIMITED) {
    const wait = Number(errorDetail(err).retry_after_seconds) || 0;
    return wait > 0
      ? `Azure is temporarily limiting requests. Please wait about ${wait} second${wait === 1 ? '' : 's'} and try again.`
      : 'Azure is temporarily limiting requests. Please wait a moment and try again.';
  }

  if (status === 403 || code === ErrorCode.FORBIDDEN || code === ErrorCode.AZURE_PERMISSION_REQUIRED) {
    const role = errorDetail(err).required_role;
    return role
      ? `You do not have permission to do this. It needs the ${role} role.`
      : 'You do not have permission to read or change this.';
  }

  if (status === 401 || code === ErrorCode.UNAUTHENTICATED) {
    return 'Your Azure session has expired. Sign in again to continue.';
  }

  if (status === 404 || code === ErrorCode.NOT_FOUND) {
    return 'That item no longer exists in Azure. It may have been changed or removed since this page was loaded.';
  }

  if (status === 504) {
    return 'Azure took too long to respond. This usually clears on its own.';
  }

  if (status && status >= 500) {
    return "We couldn't complete this right now. Please try again.";
  }

  if (err?.response === undefined && err?.message) {
    return 'We could not reach the service. Check your connection and try again.';
  }

  return errorMessage(err);
}

/**
 * Classify a failure into the state the UI should display.
 *
 * This is the function that keeps "we could not read this" from being rendered
 * as zero. Anything inconclusive must show its state, not a value.
 */
export function errorDataState(err) {
  const detail = errorDetail(err);
  if (detail.data_state) return detail.data_state;

  switch (errorCode(err)) {
    case ErrorCode.AZURE_THROTTLED:
    case ErrorCode.RATE_LIMITED:
      return DataState.THROTTLED;
    case ErrorCode.AZURE_PERMISSION_REQUIRED:
    case ErrorCode.FORBIDDEN:
      return DataState.PERMISSION_REQUIRED;
    case ErrorCode.AZURE_UNAVAILABLE:
      return DataState.UNAVAILABLE;
    default:
      return err?.response ? DataState.UNAVAILABLE : DataState.UNKNOWN;
  }
}

/** Short label for a status badge. */
export function dataStateLabel(state) {
  switch (state) {
    case DataState.CONFIRMED: return 'Confirmed';
    case DataState.ESTIMATED: return 'Estimated';
    case DataState.STALE: return 'Stale';
    case DataState.HISTORICAL: return 'Historical';
    case DataState.UNAVAILABLE: return 'Unavailable';
    case DataState.PERMISSION_REQUIRED: return 'Permission required';
    case DataState.THROTTLED: return 'Throttled';
    default: return 'Unknown';
  }
}

/**
 * What to render in place of an amount.
 *
 * Returns null when a real value should be shown instead. Callers must treat a
 * non-null result as "do not render a number here".
 */
export function placeholderForState(state) {
  return isInconclusive(state) ? dataStateLabel(state) : null;
}

/** Whether retrying could plausibly succeed. */
export function isRetryable(err) {
  return [
    ErrorCode.RATE_LIMITED,
    ErrorCode.AZURE_THROTTLED,
    ErrorCode.AZURE_UNAVAILABLE,
    ErrorCode.INTERNAL_ERROR,
  ].includes(errorCode(err));
}

/** Seconds to wait before retrying, or 0 when unknown. */
export function retryAfterSeconds(err) {
  return Number(
    err?.response?.headers?.['retry-after'] || errorDetail(err).retry_after_seconds || 0,
  );
}
