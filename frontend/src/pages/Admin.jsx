import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  ShieldCheck, Search, Trash2, Ban, RotateCcw, ChevronDown, ChevronRight,
  Users, UserCheck, UserX, Cloud, Loader2, AlertTriangle, KeyRound, Building2,
} from 'lucide-react';
import {
  fetchAdminStats, fetchAdminUser, fetchAdminUsers, updateAdminUser, deleteAdminUser,
} from '../api/client';
import { useAppStore } from '../store/useAppStore';
import Modal from '../components/Common/Modal';

const errText = (err, fallback) =>
  err?.response?.data?.detail || err?.message || fallback;

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value.includes('T') ? value : `${value}Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function relative(value) {
  if (!value) return 'never';
  const d = new Date(value.includes('T') ? value : `${value}Z`);
  if (Number.isNaN(d.getTime())) return value;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const STAT_CARDS = [
  { key: 'total_users', label: 'Total users', icon: Users, tone: 'text-blue-400 bg-blue-500/10' },
  { key: 'active_last_30d', label: 'Signed in (30 d)', icon: UserCheck, tone: 'text-emerald-400 bg-emerald-500/10' },
  { key: 'suspended_users', label: 'Suspended', icon: UserX, tone: 'text-amber-400 bg-amber-500/10' },
  { key: 'admins', label: 'Administrators', icon: ShieldCheck, tone: 'text-violet-400 bg-violet-500/10' },
  { key: 'connected_tenants', label: 'Connected tenants', icon: Cloud, tone: 'text-cyan-400 bg-cyan-500/10' },
  { key: 'new_users_30d', label: 'New in 30 days', icon: Building2, tone: 'text-pink-400 bg-pink-500/10' },
  { key: 'team_members', label: 'Team members', icon: Users, tone: 'text-sky-400 bg-sky-500/10' },
  // A compliance read: these accounts cannot be reached outside the app.
  { key: 'missing_phone', label: 'No contact number', icon: AlertTriangle, tone: 'text-orange-400 bg-orange-500/10' },
];

function StatCard({ label, value, icon: Icon, tone }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 ${tone}`}>
        <Icon className="w-4.5 h-4.5" />
      </div>
      <p className="text-2xl font-semibold text-white leading-none">{value ?? '—'}</p>
      <p className="text-xs text-slate-400 mt-1.5">{label}</p>
    </div>
  );
}

function Pill({ children, tone }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium ${tone}`}>
      {children}
    </span>
  );
}

function ConfirmDelete({ user, onCancel, onConfirm }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = text.trim().toLowerCase() === user.email.toLowerCase();

  return (
    <Modal
      title="Delete this account permanently"
      icon={AlertTriangle}
      onClose={onCancel}
      busy={busy}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            disabled={!ready || busy}
            onClick={async () => { setBusy(true); await onConfirm(); setBusy(false); }}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-[#fff] disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Delete account
          </button>
        </div>
      }
    >
      <p className="text-sm text-slate-400">
        This removes <span className="text-white">{user.name || user.email}</span> and every
        Azure credential they stored. It cannot be undone.
      </p>

      <p className="text-sm text-slate-400 mb-2 mt-4">
        Type <span className="text-white font-mono break-all">{user.email}</span> to confirm.
      </p>
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-red-500"
        placeholder={user.email}
      />
    </Modal>
  );
}

function ConnectionList({ userId }) {
  const [state, setState] = useState({ loading: true, connections: [], error: null });

  useEffect(() => {
    let alive = true;
    fetchAdminUser(userId)
      .then(d => alive && setState({ loading: false, connections: d.connections, error: null }))
      .catch(e => alive && setState({ loading: false, connections: [], error: errText(e, 'Could not load') }));
    return () => { alive = false; };
  }, [userId]);

  if (state.loading) {
    return <p className="text-sm text-slate-500 px-4 py-3">Loading connections…</p>;
  }
  if (state.error) {
    return <p className="text-sm text-red-400 px-4 py-3">{state.error}</p>;
  }
  if (!state.connections.length) {
    return (
      <p className="text-sm text-slate-500 px-4 py-3">
        This user has not connected any Azure tenant yet.
      </p>
    );
  }

  return (
    <div className="px-4 py-3 space-y-2">
      {state.connections.map(c => (
        <div
          key={`${c.source}-${c.tenant_id}`}
          className="flex items-center justify-between gap-3 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2"
        >
          <div className="min-w-0">
            <p className="text-sm text-white truncate">{c.tenant_name}</p>
            <p className="text-xs text-slate-500 font-mono truncate">{c.tenant_id}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {c.source === 'session_token'
              ? <Pill tone="bg-amber-900/60 text-amber-300"><KeyRound className="w-3 h-3" />Session token</Pill>
              : <Pill tone="bg-blue-900/60 text-blue-300"><Cloud className="w-3 h-3" />Service principal</Pill>}
            <span className="text-xs text-slate-500">{fmtDate(c.created_at)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Admin() {
  const me = useAppStore(s => s.me);
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, s] = await Promise.all([
        fetchAdminUsers({ q: query || undefined, status: statusFilter || undefined }),
        fetchAdminStats(),
      ]);
      setUsers(u);
      setStats(s);
    } catch (err) {
      setError(errText(err, 'Could not load users.'));
    } finally {
      setLoading(false);
    }
  }, [query, statusFilter]);

  useEffect(() => {
    const t = setTimeout(load, query ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  const patch = async (user, body, successMsg) => {
    setBusyId(user.id);
    try {
      const updated = await updateAdminUser(user.id, body);
      setUsers(list => list.map(u => (u.id === updated.id ? updated : u)));
      toast.success(successMsg);
      fetchAdminStats().then(setStats).catch(() => {});
    } catch (err) {
      toast.error(errText(err, 'That change was rejected.'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (user) => {
    try {
      await deleteAdminUser(user.id);
      setUsers(list => list.filter(u => u.id !== user.id));
      setPendingDelete(null);
      toast.success(`Deleted ${user.email}`);
      fetchAdminStats().then(setStats).catch(() => {});
    } catch (err) {
      toast.error(errText(err, 'Could not delete that account.'));
    }
  };

  const shown = useMemo(() => users, [users]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-white flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl bg-violet-500/15 text-violet-400 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5" />
            </span>
            Admin Center
          </h1>
          <p className="text-sm text-slate-400 mt-1.5">
            Everyone who has signed in, what they have connected, and their access.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        {STAT_CARDS.map(c => (
          <StatCard key={c.key} label={c.label} value={stats?.[c.key]} icon={c.icon} tone={c.tone} />
        ))}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="flex items-center gap-3 flex-wrap px-4 py-3 border-b border-slate-800">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex gap-1 bg-slate-950 border border-slate-700 rounded-xl p-1">
            {[['', 'All'], ['active', 'Active'], ['suspended', 'Suspended']].map(([val, label]) => (
              <button
                key={label}
                onClick={() => setStatusFilter(val)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  statusFilter === val
                    ? 'bg-blue-600 text-[#fff]'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {loading && (
          <p className="px-4 py-10 text-center text-sm text-slate-500">Loading accounts…</p>
        )}

        {!loading && error && (
          <p className="px-4 py-10 text-center text-sm text-red-400">{error}</p>
        )}

        {!loading && !error && !shown.length && (
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            {query || statusFilter ? 'No accounts match that filter.' : 'Nobody has signed in yet.'}
          </p>
        )}

        {!loading && !error && shown.map(u => {
          const isSelf = me?.id === u.id;
          const isOpen = expanded === u.id;
          const busy = busyId === u.id;
          return (
            <div key={u.id} className="border-b border-slate-800 last:border-b-0">
              <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
                <button
                  onClick={() => setExpanded(isOpen ? null : u.id)}
                  className="text-slate-500 hover:text-white shrink-0"
                  aria-label={isOpen ? 'Hide connections' : 'Show connections'}
                >
                  {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </button>

                <div className="w-9 h-9 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-xs font-semibold shrink-0">
                  {(u.name || u.email || '?').slice(0, 2).toUpperCase()}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-white truncate">{u.name || u.email}</p>
                    {u.role === 'admin' && (
                      <Pill tone="bg-violet-900/60 text-violet-300"><ShieldCheck className="w-3 h-3" />Administrator</Pill>
                    )}
                    {u.role !== 'admin' && (
                      <Pill tone="bg-slate-800 text-slate-400">Standard</Pill>
                    )}
                    {!u.is_owner && (
                      <Pill tone="bg-sky-900/60 text-sky-300" >
                        <Users className="w-3 h-3" />
                        Team member{u.owner_email ? ` of ${u.owner_email}` : ''}
                      </Pill>
                    )}
                    {u.is_owner && u.team_size > 0 && (
                      <Pill tone="bg-slate-800 text-slate-400">
                        <Users className="w-3 h-3" />{u.team_size} in team
                      </Pill>
                    )}
                    {u.status === 'suspended'
                      ? <Pill tone="bg-red-900/60 text-red-300">Suspended</Pill>
                      : <Pill tone="bg-emerald-900/60 text-emerald-300">Active</Pill>}
                    {isSelf && <Pill tone="bg-slate-800 text-slate-400">You</Pill>}
                  </div>
                  <p className="text-xs text-slate-500 truncate">
                    {u.email}
                    {/* An account with no number cannot be reached outside the
                        app. Entra does not supply one, so it stays blank until
                        the person enters it, and blank is stated rather than
                        filled in with something plausible. */}
                    <span className="mx-1.5 text-slate-700">·</span>
                    {u.phone
                      ? <span className="text-slate-400">{u.phone}</span>
                      : <span className="text-amber-500/80">No contact number</span>}
                  </p>
                </div>

                <div className="hidden lg:block text-xs text-slate-400 w-32 shrink-0">
                  <p className="text-white">{u.tenant_count}</p>
                  <p>tenant{u.tenant_count === 1 ? '' : 's'}</p>
                </div>
                <div className="hidden lg:block text-xs text-slate-400 w-32 shrink-0">
                  <p className="text-white">
                    {u.days_since_registered == null
                      ? 'Not available'
                      : `${u.days_since_registered} day${u.days_since_registered === 1 ? '' : 's'}`}
                  </p>
                  {/* Account age, not days of measured usage: the app records
                      only the most recent sign-in, not a per-day history. */}
                  <p>registered</p>
                </div>
                <div className="hidden lg:block text-xs text-slate-400 w-32 shrink-0">
                  <p className="text-white">{relative(u.last_login_at)}</p>
                  <p>
                    last seen
                    {u.login_count ? ` · ${u.login_count} sign-in${u.login_count === 1 ? '' : 's'}` : ''}
                  </p>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    disabled={busy || isSelf}
                    title={isSelf ? 'You cannot change your own role' : 'Change role'}
                    onClick={() => patch(
                      u,
                      { role: u.role === 'admin' ? 'user' : 'admin' },
                      u.role === 'admin' ? `${u.email} is now a standard user` : `${u.email} is now an admin`,
                    )}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    {u.role === 'admin' ? 'Demote' : 'Make admin'}
                  </button>

                  <button
                    disabled={busy || isSelf}
                    title={isSelf ? 'You cannot suspend yourself' : 'Suspend or reinstate'}
                    onClick={() => patch(
                      u,
                      { status: u.status === 'suspended' ? 'active' : 'suspended' },
                      u.status === 'suspended' ? `${u.email} can sign in again` : `${u.email} is suspended`,
                    )}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1.5 ${
                      u.status === 'suspended' ? 'text-emerald-400' : 'text-amber-400'
                    }`}
                  >
                    {u.status === 'suspended'
                      ? <><RotateCcw className="w-3.5 h-3.5" />Reinstate</>
                      : <><Ban className="w-3.5 h-3.5" />Suspend</>}
                  </button>

                  <button
                    disabled={busy || isSelf}
                    title={isSelf ? 'You cannot delete your own account' : 'Delete permanently'}
                    onClick={() => setPendingDelete(u)}
                    className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {isOpen && <ConnectionList userId={u.id} />}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-slate-500">
        Suspending blocks access immediately but keeps the account and its data, so it can be
        reversed. Deleting also destroys every stored Azure credential and cannot be undone.
      </p>

      {pendingDelete && (
        <ConfirmDelete
          user={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => remove(pendingDelete)}
        />
      )}
    </div>
  );
}
