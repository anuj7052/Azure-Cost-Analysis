import { useEffect, useState } from 'react';
import { ShieldCheck, Download, Trash2, Clock, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAppStore } from '../../store/useAppStore';
import { updateProfile, fetchMySessions, exportMyData } from '../../api/client';
import { errorMessage } from '../../utils/apiError';

/**
 * What this app keeps about the person using it, and their say over it.
 *
 * The panel is the consent mechanism, not a description of one. Until somebody
 * agrees here, the API stores no phone number, no employer and no session
 * history at all -- so this is not a checkbox that unlocks a form, it is the
 * thing that makes the collection lawful in the first place.
 *
 * It also carries the two rights that are worthless as a support process:
 * getting a copy, and having it erased. Both are one click, because a right
 * that takes an email and a week is one most people never exercise.
 */
export default function YourDataPanel() {
  const me = useAppStore(s => s.me);
  const setMe = useAppStore(s => s.setMe);

  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [saving, setSaving] = useState(false);
  const [sessions, setSessions] = useState(null);
  const consented = !!me?.has_consented;

  // Seeded from the server rather than held only in the form, so a reload
  // shows what is actually stored instead of what was last typed.
  useEffect(() => {
    setPhone(me?.phone || '');
    setCompany(me?.company || '');
  }, [me?.phone, me?.company]);

  useEffect(() => {
    if (!consented) { setSessions(null); return; }
    let cancelled = false;
    fetchMySessions()
      .then(d => { if (!cancelled) setSessions(d.sessions || []); })
      // A history we cannot load is reported as unknown, never as "none":
      // "you have no sign-ins" would be a claim, and it would be wrong.
      .catch(() => { if (!cancelled) setSessions('error'); });
    return () => { cancelled = true; };
  }, [consented]);

  const save = async (body, message) => {
    setSaving(true);
    try {
      setMe(await updateProfile(body));
      toast.success(message);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async () => {
    const ok = window.confirm(
      'This deletes your phone number, your company name and your entire ' +
      'sign-in history from this app. Your account stays, so you can still ' +
      'sign in. This cannot be undone.'
    );
    if (!ok) return;
    await save({ consent: false }, 'Deleted. We are no longer keeping those details.');
  };

  const download = async () => {
    try {
      const data = await exportMyData();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cloudledger-my-data.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
      <div className="flex items-start gap-3 mb-4">
        <ShieldCheck className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
        <div>
          <h2 className="text-sm font-semibold text-white">Your data</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            What this app keeps about you, and what you can do about it.
          </p>
        </div>
      </div>

      {/* What arrives with the sign-in and is not optional. Saying so plainly
          is the difference between a consent notice and a dark pattern. */}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm mb-5">
        <div>
          <dt className="text-xs text-slate-500">Name</dt>
          <dd className="text-white">{me?.name || 'Not available'}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Email</dt>
          <dd className="text-white break-all">{me?.email || 'Not available'}</dd>
        </div>
      </dl>
      <p className="text-xs text-slate-500 -mt-3 mb-5">
        Name and email come from your Microsoft sign-in. They are what makes an
        account work, so they cannot be removed while the account exists.
      </p>

      {!consented ? (
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-sm text-slate-300">
            We would also like to keep your phone number, your company name and
            a record of when you sign in and out. Two reasons, and no others:
          </p>
          <ul className="text-xs text-slate-400 mt-3 space-y-1.5 list-disc pl-4">
            <li>
              <span className="text-slate-300">To contact you</span> — about the
              product, and to ask what you think of it.
            </li>
            <li>
              <span className="text-slate-300">To see how the app is used</span> —
              which features get opened, and how often, so we build the right
              ones next.
            </li>
          </ul>
          <ul className="text-xs text-slate-500 mt-3 space-y-1.5">
            <li>Sign-in records are deleted after {me?.session_retention_days ?? 90} days.</li>
            <li>Your IP address is stored only as a one-way hash, never as an address.</li>
            <li>Never sold, and never passed to an advertiser.</li>
            <li>You can download it or delete it at any time, from here.</li>
          </ul>
          <button
            onClick={() => save({ consent: true }, 'Thanks — you can change this any time.')}
            disabled={saving}
            className="mt-4 flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-xl transition"
          >
            <Check className="w-4 h-4" />
            I agree
          </button>
          <p className="text-xs text-slate-600 mt-2">
            Declining changes nothing about how the app works for you.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-500">Phone number</span>
              <input
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="Optional"
                className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Company</span>
              <input
                value={company}
                onChange={e => setCompany(e.target.value)}
                placeholder="Optional"
                className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
              />
            </label>
          </div>
          <button
            onClick={() => save({ phone, company }, 'Saved')}
            disabled={saving}
            className="mt-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-xl transition"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>

          <div className="mt-6 pt-5 border-t border-slate-800">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-slate-500" />
              <h3 className="text-sm font-medium text-white">Recent sign-ins</h3>
            </div>
            {sessions === null && (
              <p className="text-xs text-slate-500">Reading your sign-in history…</p>
            )}
            {sessions === 'error' && (
              <p className="text-xs text-slate-500">Not available right now.</p>
            )}
            {Array.isArray(sessions) && sessions.length === 0 && (
              <p className="text-xs text-slate-500">
                Nothing recorded yet. This one will appear next time you open the app.
              </p>
            )}
            {Array.isArray(sessions) && sessions.length > 0 && (
              <ul className="space-y-2">
                {sessions.slice(0, 8).map(s => (
                  <li key={s.id} className="text-xs flex items-baseline justify-between gap-3">
                    <span className="text-slate-300">{s.started_at}</span>
                    <span className="text-slate-500 text-right">
                      {/* An open session is stated as open. A browser that was
                          simply closed never told us when it ended, and an
                          invented end time would be a guess printed as a fact. */}
                      {s.active ? 'Still open' : `until ${s.ended_at}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-slate-600 mt-3">
              Kept for {me?.session_retention_days ?? 90} days, then deleted automatically.
            </p>
          </div>

          <div className="mt-6 pt-5 border-t border-slate-800 flex flex-wrap gap-2">
            <button
              onClick={download}
              className="flex items-center gap-2 border border-slate-700 hover:border-slate-600 text-slate-300 hover:text-white text-sm px-3 py-2 rounded-xl transition"
            >
              <Download className="w-4 h-4" />
              Download my data
            </button>
            <button
              onClick={withdraw}
              disabled={saving}
              className="flex items-center gap-2 border border-red-900/60 hover:border-red-700 text-red-400 hover:text-red-300 disabled:opacity-50 text-sm px-3 py-2 rounded-xl transition"
            >
              <Trash2 className="w-4 h-4" />
              Delete these details
            </button>
          </div>
        </>
      )}
    </div>
  );
}
