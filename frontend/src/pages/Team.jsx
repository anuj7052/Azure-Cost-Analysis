import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Users, UserPlus, Mail, Trash2, Loader2, ShieldCheck, Eye, Phone, Check,
} from 'lucide-react';
import {
  fetchTeam, inviteTeamMember, revokeInvitation, removeTeamMember, updateProfile,
} from '../api/client';
import { useAppStore } from '../store/useAppStore';
import { Button, Card, EmptyState, ErrorState, Callout, Skeleton } from '../components/ui';

const errText = (err, fallback) =>
  err?.response?.data?.detail || err?.message || fallback;

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

function MemberRow({ member, canManage, onRemove, busy }) {
  const pending = member.state === 'pending';
  const suspended = member.account_status === 'suspended';

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
  const [email, setEmail] = useState('');
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

  const invite = async (e) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    try {
      setTeam(await inviteTeamMember(address));
      setEmail('');
      toast.success(`${address} can now sign in to this workspace`);
    } catch (err) {
      toast.error(errText(err, 'Could not send that invitation'));
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
              ? 'People from your Microsoft directory who can see the Azure tenants you connected.'
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
        <Callout tone="info" title="You have view access">
          <p>
            {team.owner_email
              ? <>This workspace belongs to <span className="text-slate-200">{team.owner_email}</span>. </>
              : null}
            You can see everything they connected, and you cannot connect or
            disconnect tenants, change stored credentials, or make changes in
            Azure. Ask them if you need one of those.
          </p>
        </Callout>
      )}

      {canManage && (
        <Card className="p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-100">Invite a colleague</h2>
          </div>
          <p className="mb-3 text-xs text-slate-400">
            They must be in the same Microsoft directory as you. They will get
            view access to this workspace the first time they sign in — an
            invitation sent to an address outside your directory cannot be used.
          </p>
          <form onSubmit={invite} className="flex flex-wrap gap-2">
            <div className="relative min-w-0 flex-1">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@yourcompany.com"
                disabled={full || busy}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
              />
            </div>
            <Button type="submit" disabled={full || busy || !email.trim()} className="shrink-0">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              Send invitation
            </Button>
          </form>
          {full && (
            <p className="mt-2 text-xs text-amber-300">
              All {team.limit} seats are taken. Remove someone below to free one.
            </p>
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold text-slate-100">
            Workspace access
          </h2>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            <Eye className="h-3.5 w-3.5" />
            View only
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
              ? 'Invite up to five colleagues from your Microsoft directory to share this view.'
              : 'No other people have been given access to this workspace.'}
          />
        ) : (
          team.members.map(member => (
            <MemberRow
              key={member.invitation_id ? `i${member.invitation_id}` : `m${member.id}`}
              member={member}
              canManage={canManage}
              onRemove={remove}
              busy={busy}
            />
          ))
        )}
      </Card>

      <ContactCard me={me} onSaved={setMe} />
    </div>
  );
}
