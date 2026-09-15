// Share the network request across store loaders and component-local queries.
// A failed promise is removed too, so Retry can issue a new request.
const pending = new Map();

export function dedupeRequest(key, run) {
  if (pending.has(key)) return pending.get(key);
  const promise = Promise.resolve().then(run).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

export function partialResponse(data) {
  return Boolean(data?.coverage?.partial || data?.coverage?.errors?.length || data?.errors?.length);
}
