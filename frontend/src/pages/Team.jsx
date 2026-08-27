import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Users, UserPlus, Trash2, Loader2, ShieldCheck, Eye, Phone, Check,
  Search, Shield, X,
} from 'lucide-react';
import {
  fetchTeam, inviteTeamMember, revokeInvitation, removeTeamMember, updateProfile,
  searchDirectory, setMemberRole, setInvitationRole,
} from '../api/client';
import { useAppStore } from '../store/useAppStore';
import { Button, Card, EmptyState, ErrorState, Callout, Skeleton } from '../components/ui';

const errText = (err, fallback) =>
  err?.response?.data?.detail || err?.message || fallback;

/**
 * The two things a person can be, in this workspace and nowhere else.
 *
 * "Administrator" here means administrator of this workspace: it does not open
 * the platform admin centre and does not reveal any other customer's account.
 * The wording says what each one can actually do, because "admin" on its own
 * means whatever the reader last assumed it meant.
 */
const ROLES = [
  {
    value: 'user',
    label: 'User',
    blurb: 'Can see everything in this workspace. Cannot change anything.',
  },
  {
    value: 'admin',
    label: 'Administrator',
    blurb: 'Can also connect tenants, edit credentials and create resources in Azure.',
  },
];

const roleLabel = (value) =>
  ROLES.find(r => r.value === value)?.label || 'User';

function fmtDate(value) {
  if (!value) return 'Not available';
  const d = new Date(value.includes('T') ? value : `${value}Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

/**
 * Seats drawn as blocks rather than written as "3 / 5".
 *
 * The number that matters when you are about to invite someone is how many are
 * left, and a row of blocks answers that without arithmetic.
 */
function SeatMeter({ accepted, pending, limit }) {
  const blocks = Array.from({ length: limit }, (_, i) => {
    if (i < accepted) return 'filled';
    if (i < accepted + pending) return 'pending';
    return 'free';
  });

  return (
    <div className="flex items-center gap-1.5" aria-hidden="true">
      {blocks.map((state, i) => (
        <span
          key={i}
          className={`h-2 w-6 rounded-full ${
            state === 'filled' ? 'bg-emerald-500'
              : state === 'pending' ? 'bg-amber-500/70'
                : 'bg-slate-700'
          }`}
        />
      ))}
    </div>
  );
}

/**
 * Role as two buttons rather than a dropdown.
 *
 * There are only two choices and the difference between them matters, so both
 * are shown with what they mean. A dropdown would hide the consequence of the
 * option you did not pick behind a click.
 */
function RoleChoice({ value, onChange, disabled }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {ROLES.map(role => {
        const active = value === role.value;
        return (
          <button
            key={role.value}
            type="button"
            onClick={() => onChange(role.value)}
            disabled={disabled}
            aria-pressed={active}
            className={`rounded-xl border p-3 text-left transition disabled:opacity-50 ${
              active
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-slate-700 bg-slate-950 hover:border-slate-600'
            }`}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium text-slate-100">
              <Shield className={`h-3.5 w-3.5 ${active ? 'text-blue-400' : 'text-slate-500'}`} />
              {role.label}
            </span>
            <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">
              {role.blurb}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Find a person in your own Microsoft directory and give them a role.
 *
 * Typing a name and picking a real person is both faster than typing an email
 * address and impossible to get subtly wrong, which matters here because a
 * mistyped address produces an invitation nobody can ever redeem.
 *
 * Directory search needs a Graph permission that many tenants have not granted.
 * When it is missing the box does not go quiet or throw: it says what is
 * missing and accepts a full email address instead, so the feature degrades
 * rather than disappears.
 */
function AddPerson({ full, limit, busy, onAdd }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [note, setNote] = useState('');
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [picked, setPicked] = useState(null);
  const [role, setRole] = useState('user');
  const latest = useRef(0);

  useEffect(() => {
    if (picked) return undefined;
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setNote('');
      setSearched(false);
      return undefined;
    }

    // Debounced: a request per keystroke would throttle Graph and show answers
    // for a word the person had already finished changing.
    const ticket = ++latest.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await searchDirectory(term);
        if (ticket !== latest.current) return;
        setResults(data.people || []);
        setNote(data.note || '');
      } catch (err) {
        if (ticket !== latest.current) return;
        setResults([]);
        setNote(errText(err, 'Could not search your directory.'));
      } finally {
        if (ticket === latest.current) {
          setSearching(false);
          setSearched(true);
        }
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, picked]);

  const typedEmail = query.trim();
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typedEmail);
  const target = picked || (looksLikeEmail ? { name: typedEmail, email: typedEmail } : null);

  const reset = () => {
    setPicked(null);
    setQuery('');
    setResults([]);
    setNote('');
    setSearched(false);
    setRole('user');
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!target) return;
    const ok = await onAdd(target.email, role);
    if (ok) reset();
  };

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-slate-400" />
        <h2 className="text-sm font-semibold text-slate-100">Give someone access</h2>
      </div>
      <p className="mb-3 text-xs text-slate-400">
        Start typing a name and pick the person from your Microsoft directory,
        then choose what they may do. They get access the first time they sign
        in with their work account.
      </p>

      <form onSubmit={submit} className="space-y-3">
        {picked ? (
          <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-[11px] font-semibold text-blue-300">
              {(picked.name || picked.email).slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-slate-100">{picked.name || picked.email}</span>
              <span className="block truncate text-xs text-slate-400">{picked.email}</span>
            </span>
            <button
              type="button"
              onClick={reset}
              className="shrink-0 rounded-lg p-1 text-slate-400 hover:text-slate-200"
              title="Choose someone else"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="relative">
            {searching
              ? <Loader2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-500" />
              : <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />}
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your directory by name"
              disabled={full || busy}
              autoComplete="off"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />

            {results.length > 0 && (
              <ul className="mt-2 max-h-60 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950">
                {results.map(person => (
                  <li key={person.id || person.email}>
                    <button
                      type="button"
                      onClick={() => setPicked(person)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-800/70"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[11px] font-semibold text-slate-300">
                        {(person.name || person.email).slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-slate-100">{person.name}</span>
                        <span className="block truncate text-xs text-slate-400">
                          {person.job_title ? `${person.job_title} · ` : ''}{person.email}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!picked && note && (
          <p className="text-xs text-amber-300">{note}</p>
        )}
        {!picked && !note && searched && !searching && results.length === 0 && (
          <p className="text-xs text-slate-400">
            Nobody in your directory matches that. Check the spelling, or type
            their full email address.
          </p>
        )}
        {!picked && looksLikeEmail && (
          <p className="text-xs text-slate-400">
            Using the address you typed. It must belong to your Microsoft
            directory, or the person will not be able to sign in.
          </p>
        )}

        <RoleChoice value={role} onChange={setRole} disabled={full || busy} />

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={full || busy || !target} className="shrink-0">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Add to workspace
          </Button>
          {target && (
            <span className="text-xs text-slate-400">
              {target.name || target.email} as {roleLabel(role)}
            </span>
          )}
        </div>
      </form>

      {full && (
        <p className="mt-2 text-xs text-amber-300">
          All {limit} seats are taken. Remove someone below to free one.
        </p>
      )}
    </Card>
  );
}

function MemberRow({ member, canManage, onRemove, onRoleChange, busy }) {
  const pending = member.state === 'pending';
  const suspended = member.account_status === 'suspended';
  const role = member.role || 'user';

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-slate-800/70 px-4 py-3 last:border-b-0 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-slate-100">
            {member.name || member.email}
          </p>
          {pending && (
            <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              Invited — not signed in yet
            </span>
          )}
          {suspended && (
            <span className="rounded-md bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300">
              Suspended
            </span>
          )}
        </div>
        <p className="truncate text-xs text-slate-400">{member.email}</p>
      </div>

      {canManage ? (
        <label className="shrink-0">
          <span className="sr-only">Role for {member.email}</span>
          <select
            value={role}
            disabled={busy}
            onChange={(e) => onRoleChange(member, e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-50"
          >
            {ROLES.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </label>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-slate-800/70 px-2 py-0.5 text-[11px] text-slate-300">
          <Shield className="h-3 w-3" />
          {member.role_label || roleLabel(role)}
        </span>
      )}

      <div className="hidden text-right sm:block">
        <p className="text-xs text-slate-300">
          {pending ? 'Not joined' : fmtDate(member.joined_at)}
        </p>
        <p className="text-[11px] text-slate-500">
          {pending
            ? 'Invitation open'
            : member.login_count
              ? `${member.login_count} sign-in${member.login_count === 1 ? '' : 's'}`
              : 'No sign-ins recorded'}
        </p>
      </div>

      {canManage && (
        <Button
          variant="ghost"
          onClick={() => onRemove(member)}
          disabled={busy}
          className="shrink-0 text-slate-400 hover:text-rose-300"
          title={pending ? 'Cancel this invitation' : 'Remove from workspace'}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

/**
 * The phone number the admin centre reports for compliance.
 *
 * It is asked for here rather than at registration because Entra sign-in
 * tokens carry no phone number, and blocking the first sign-in behind a form
 * would be a worse trade than an empty field that reads "Not available".
 */
function ContactCard({ me, onSaved }) {
  const [phone, setPhone] = useState(me?.phone || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setPhone(me?.phone || ''); }, [me?.phone]);

  const dirty = (me?.phone || '') !== phone.trim();

  const save = async () => {
    setSaving(true);
    try {
      const updated = await updateProfile({ phone: phone.trim() });
      onSaved(updated);
      toast.success('Contact number saved');
    } catch (err) {
      toast.error(errText(err, 'Could not save your contact number'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <Phone className="h-4 w-4 text-slate-400" />
        <h2 className="text-sm font-semibold text-slate-100">Your contact number</h2>
      </div>
      <p className="mb-3 text-xs text-slate-400">
        Used by your administrator to reach you about this account. Microsoft
        sign-in does not share a phone number, so this is only what you enter.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+91 98765 43210"
          className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
        />
        <Button onClick={save} disabled={!dirty || saving} className="shrink-0">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Save
        </Button>
      </div>
    </Card>
  );
}

export default function Team() {
  const me = useAppStore(s => s.me);
  const setMe = useAppStore(s => s.setMe);

  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setTeam(await fetchTeam());
    } catch (err) {
      setError(errText(err, 'Could not load your team'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async (address, role) => {
    setBusy(true);
    try {
      setTeam(await inviteTeamMember(address, role));
      toast.success(`${address} added as ${roleLabel(role)}`);
      return true;
    } catch (err) {
      toast.error(errText(err, 'Could not add that person'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member, role) => {
    if (role === (member.role || 'user')) return;
    const label = member.name || member.email;
    if (role === 'admin' && !window.confirm(
      `Make ${label} an administrator of this workspace? They will be able to `
      + 'connect tenants, edit stored credentials and create resources in Azure.',
    )) return;

    setBusy(true);
    try {
      setTeam(member.state === 'pending'
        ? await setInvitationRole(member.invitation_id, role)
        : await setMemberRole(member.id, role));
      toast.success(`${label} is now ${roleLabel(role)}`);
    } catch (err) {
      toast.error(errText(err, 'Could not change that role'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (member) => {
    const label = member.name || member.email;
    const question = member.state === 'pending'
      ? `Cancel the invitation for ${label}?`
      : `Remove ${label}? They will immediately lose access to this workspace.`;
    if (!window.confirm(question)) return;

    setBusy(true);
    try {
      setTeam(member.state === 'pending'
        ? await revokeInvitation(member.invitation_id)
        : await removeTeamMember(member.id));
      toast.success('Access removed');
    } catch (err) {
      toast.error(errText(err, 'Could not remove that person'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) return <ErrorState message={error} onRetry={load} />;

  const canManage = team?.is_owner;
  const full = (team?.remaining ?? 0) <= 0;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-white">
            <Users className="h-5 w-5 text-blue-400" />
            Your team
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {canManage
              ? 'People from your Microsoft directory who can reach the Azure tenants you connected, and what each of them may do.'
              : 'The people who share this workspace with you.'}
          </p>
        </div>
        <div className="text-right">
          <SeatMeter
            accepted={team.accepted}
            pending={team.pending}
            limit={team.limit}
          />
          <p className="mt-1.5 text-xs text-slate-400">
            {team.remaining} of {team.limit} seats free
          </p>
        </div>
      </header>

      {!canManage && (
        <Callout
          tone="info"
          title={me?.can_administer
            ? 'You are an administrator of this workspace'
            : 'You have view access'}
        >
          <p>
            {team.owner_email
              ? <>This workspace belongs to <span className="text-slate-200">{team.owner_email}</span>. </>
              : null}
            {me?.can_administer
              ? <>You can connect tenants, edit stored credentials and make changes
                in Azure here. Only the owner can add or remove people, or change
                what they are allowed to do.</>
              : <>You can see everything they connected, and you cannot connect or
                disconnect tenants, change stored credentials, or make changes in
                Azure. Ask them if you need one of those.</>}
          </p>
        </Callout>
      )}

      {canManage && (
        <AddPerson
          full={full}
          limit={team.limit}
          busy={busy}
          onAdd={add}
        />
      )}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold text-slate-100">
            Workspace access
          </h2>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            <Eye className="h-3.5 w-3.5" />
            Role in this workspace
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-slate-800/70 bg-slate-900/40 px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-100">
              {team.owner_email || 'Workspace owner'}
            </p>
            <p className="text-xs text-slate-400">Owner</p>
          </div>
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
        </div>

        {team.members.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody else yet"
            description={canManage
              ? 'Search your Microsoft directory above to give up to five colleagues access to this workspace.'
              : 'No other people have been given access to this workspace.'}
          />
        ) : (
          team.members.map(member => (
            <MemberRow
              key={member.invitation_id ? `i${member.invitation_id}` : `m${member.id}`}
              member={member}
              canManage={canManage}
              onRemove={remove}
              onRoleChange={changeRole}
              busy={busy}
            />
          ))
        )}
      </Card>

      <ContactCard me={me} onSaved={setMe} />
    </div>
  );
}
