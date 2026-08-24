import { useCallback, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';

/*
 * Non-component helpers for the Access & Security pages.
 *
 * These live apart from SecurityShell.jsx only because Vite's fast refresh
 * requires a module to export components or plain values, never both.
 */

/**
 * Run one security endpoint, on demand.
 *
 * Deliberately not automatic on mount. These calls fan out across every
 * selected subscription and hit four different Azure providers; firing them on
 * every navigation would burn quota and rate limits for a page the user may
 * only be passing through.
 */
export function useSecurityQuery(fetcher) {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const subscriptionIds = useAppStore(s => s.selectedSubscriptionIds);

  const [state, setState] = useState({ data: null, error: null, loading: false });

  const run = useCallback((extra = {}) => {
    if (!tenantId || subscriptionIds.length === 0) return;

    setState({ data: null, error: null, loading: true });
    fetcher({ tenant_id: tenantId, subscription_ids: subscriptionIds, ...extra })
      .then((result) => {
        // A helper that already unwrapped the axios envelope returns the body
        // directly. Guarding on the shape means a malformed response ends the
        // spinner with an error instead of leaving it turning for ever.
        if (!result || typeof result !== 'object') {
          setState({ data: null, error: 'The server returned an unexpected response.', loading: false });
          return;
        }
        setState({ data: result, error: null, loading: false });
      })
      .catch((err) => {
        setState({
          data: null,
          error: err.response?.data?.detail || err.message || 'Could not read from Azure.',
          loading: false,
        });
      });
  }, [fetcher, tenantId, subscriptionIds]);

  return { ...state, run, ready: Boolean(tenantId) && subscriptionIds.length > 0 };
}

/**
 * SQLite stores UTC without a zone marker; without the Z the browser reads it
 * as local time and every snapshot appears hours out.
 */
export function when(timestamp) {
  if (!timestamp) return '—';
  const raw = String(timestamp);
  const date = new Date(`${raw.replace(' ', 'T')}${raw.endsWith('Z') ? '' : 'Z'}`);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}
