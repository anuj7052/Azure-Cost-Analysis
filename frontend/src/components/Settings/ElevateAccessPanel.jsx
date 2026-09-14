import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button, Panel, Callout, Badge } from '../ui';
import { fetchElevationStatus, elevateAccess, removeElevation } from '../../api/client';
import { elevationState } from '../../utils/elevation';

/*
 * The way out of an empty subscription list.
 *
 * Entra ID and Azure RBAC are separate permission systems, and Global
 * Administrator -- the highest role a directory has -- conveys no rights over
 * subscriptions at all. So a Global Administrator can connect their tenant and
 * be shown nothing, with no error that is true enough to display. Azure's own
 * answer is elevation: a Global Administrator may take User Access
 * Administrator at the root scope and then see the estate.
 *
 * This panel lives in Settings, next to the tenant list, because that is where
 * somebody is standing when the list comes back empty. Putting it behind a
 * documentation link would mean the product knows the answer and declines to
 * give it.
 */
export default function ElevateAccessPanel({ tenantId, subscriptionCount = null }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      setStatus(await fetchElevationStatus(tenantId));
    } catch (err) {
      // Kept as an unknown rather than thrown away. The panel must render
      // something, and "we could not check" is a different message from "you
      // are not elevated" -- the second would invite a pointless click.
      setStatus({ unknown: true, elevated: false, error: err.response?.data?.detail || err.message });
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { refresh(); }, [refresh]);

  const view = elevationState(status, { subscriptionCount });

  const run = async (fn, done) => {
    setWorking(true);
    try {
      await fn(tenantId);
      toast.success(done);
      // Re-read rather than assume the new state. This is the one fact in the
      // app worth an extra round trip to be sure about.
      await refresh();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message);
    } finally {
      setWorking(false);
    }
  };

  if (!tenantId) return null;

  return (
    <Panel
      title="Tenant-wide access"
      hint="Why a Global Administrator can still see nothing"
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          loading={loading}
          disabled={working}
          icon={RefreshCw}
        >
          Re-check
        </Button>
      }
    >
      {view.state === 'unknown' && (
        <Callout tone="info" title="Could not check your access level">
          <p>
            Azure did not answer when asked whether you hold elevated access.
            Nothing has changed either way -- this is only a failed question.
          </p>
          {view.error && <p className="mt-2 text-xs opacity-80">{view.error}</p>}
        </Callout>
      )}

      {view.state === 'needed' && (
        <Callout tone="medium" title="This tenant is showing no subscriptions">
          <p>
            That usually is not a fault. Global Administrator is a directory
            role in Entra ID, and it grants nothing over subscriptions, which
            are governed separately by Azure RBAC. If you are a Global
            Administrator, you can assign yourself access to the whole tenant
            below and the estate should appear.
          </p>
        </Callout>
      )}

      {view.state === 'offer' && (
        <p className="text-sm text-slate-400">
          You are not currently elevated, and this tenant is returning data, so
          nothing here needs fixing. Elevation is available if you need to
          reach a subscription you have not been granted a role on.
        </p>
      )}

      {view.state === 'elevated' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={view.tone === 'medium' ? 'medium' : 'good'}>
              User Access Administrator
            </Badge>
            <span className="text-slate-400">
              at the tenant root, taken {view.age?.label ?? 'at an unknown time'}
            </span>
          </div>

          {view.tone === 'medium' ? (
            <Callout tone="medium" title="This elevation has been standing for a while">
              <p>
                Elevation is meant to last as long as the task that needed it.
                Left in place it is a tenant-wide administrator that no access
                review has looked at -- the same finding this tool raises about
                everybody else. If you are finished with it, remove it.
              </p>
            </Callout>
          ) : (
            <p className="text-sm text-slate-400">
              You can see every subscription and management group in this
              tenant. Remove this when you are done with whatever needed it.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {view.canElevate && (
          <Button
            variant={view.state === 'needed' ? 'primary' : 'secondary'}
            loading={working}
            disabled={loading}
            onClick={() => run(elevateAccess, 'Elevated. Reload to see the full estate.')}
          >
            Elevate my access
          </Button>
        )}
        {view.canRemove && (
          <Button
            variant="danger"
            loading={working}
            disabled={loading}
            onClick={() => run(removeElevation, 'Elevation removed.')}
          >
            Remove elevation
          </Button>
        )}
      </div>

      {view.canElevate && (
        <ul className="mt-4 space-y-1 text-xs text-slate-500">
          {/* Stated before the click, not after. The risk here is reach
              rather than damage, and reach is the thing a confirmation dialog
              is worst at conveying. */}
          <li>Azure permits this only for Global Administrators. It cannot grant access to anybody else.</li>
          <li>The assignment sits above every subscription and management group, including ones created later.</li>
          <li>Entra ID records it in the directory activity log independently of this application.</li>
          <li>It is reversible from here at any time.</li>
        </ul>
      )}
    </Panel>
  );
}
