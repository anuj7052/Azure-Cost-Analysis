/**
 * The dialog that stands between a click and a real change to Azure access.
 *
 * Everything else in this section reads. This is the one place a user can alter
 * who can reach their estate, and the design follows from a single observation:
 * the cost of an accidental click here is not a wrong number on a screen, it is
 * somebody losing access to production, or gaining it.
 *
 * So the flow is deliberately slow. The preview is fetched from the server
 * before anything is offered, the checks it returns are shown individually
 * rather than reduced to a yes or no, and the confirm button stays disabled
 * until the server has said the change can actually be applied. For roles that
 * can lock an estate out of its own administration, the user must type the name
 * of the account as well -- not as security theatre, but because muscle memory
 * defeats a button and does not defeat a keyboard.
 *
 * The preview is not what makes this safe. The server re-runs every check
 * before it calls Azure, so a discarded preview or a hand-crafted request is
 * refused just the same. The preview is what makes it *understandable*.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Loader2, Lock, ShieldAlert, X } from 'lucide-react';
import { friendlyError } from '../../utils/apiError';
import { lockScroll, unlockScroll } from '../../utils/scrollLock';
import { UNRESOLVED_LABEL } from '../../utils/identity';

const STAGE_REVIEW = 'review';
const STAGE_WORKING = 'working';
const STAGE_DONE = 'done';

function CheckRow({ item }) {
  const Icon = item.ok ? Check : X;
  return (
    <div className="flex items-start gap-2.5">
      <Icon
        size={14}
        className={`mt-0.5 shrink-0 ${item.ok ? 'text-emerald-400' : 'text-red-400'}`}
      />
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-200">{item.label}</p>
        <p className="text-[11px] text-slate-400 leading-relaxed">{item.note}</p>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <div className="mt-0.5 text-sm text-slate-200">{children}</div>
    </div>
  );
}

export default function AccessChangeDialog({
  open,
  title,
  verb,
  loadPreview,
  apply,
  onClose,
  onApplied,
}) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState(STAGE_REVIEW);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState(null);
  const panel = useRef(null);
  const returnTo = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setPreview(null);
    setError('');
    setStage(STAGE_REVIEW);
    setTyped('');
    setResult(null);
    setLoading(true);

    loadPreview()
      .then(data => { if (live) setPreview(data); })
      .catch(err => { if (live) setError(friendlyError(err)); })
      .finally(() => { if (live) setLoading(false); });

    return () => { live = false; };
    // loadPreview is rebuilt by the parent on every render, so depending on it
    // would refetch the preview in a loop. `open` is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Held separately from the fetch above so that a preview retry cannot
  // release the page while the dialog is still on screen.
  useEffect(() => {
    if (!open) return undefined;
    lockScroll();
    return unlockScroll;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // Escape closes, except while a write is in flight. Dismissing the dialog
    // then would hide an operation that is still running and leave the reader
    // with no way to learn whether it succeeded.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (stage !== STAGE_WORKING) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, stage, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    // Focus has to move into the dialog, or Escape never reaches it and the
    // keyboard carries on walking the page behind the overlay.
    returnTo.current = document.activeElement;
    panel.current?.focus();
    return () => {
      const target = returnTo.current;
      if (target && typeof target.focus === 'function' && document.contains(target)) {
        target.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const highRisk = Boolean(preview?.high_risk);
  const rawTarget = preview?.principal_name || '';
  // "Name unavailable" is a placeholder, not a name. Asking someone to type it
  // out would turn a deliberate safety check into a transcription exercise
  // that proves nothing about who they think they are removing.
  const target = rawTarget === UNRESOLVED_LABEL ? '' : rawTarget;
  // A typed confirmation is only asked for when it can actually be given. If
  // the account could not be named there is nothing to type, and demanding a
  // GUID would teach people to paste without reading.
  const needsTyping = highRisk && Boolean(target);
  const typedOk = !needsTyping || typed.trim().toLowerCase() === target.trim().toLowerCase();
  const canApply = Boolean(preview?.can_apply) && typedOk && stage === STAGE_REVIEW;

  async function run() {
    setStage(STAGE_WORKING);
    setError('');
    try {
      const data = await apply();
      setResult(data);
      setStage(STAGE_DONE);
      onApplied?.(data);
    } catch (err) {
      setError(friendlyError(err));
      setStage(STAGE_REVIEW);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60"
        aria-hidden="true"
        // Backdrop dismissal is disabled mid-write for the same reason Escape
        // is: the operation continues regardless of the dialog.
        onClick={() => { if (stage !== STAGE_WORKING) onClose(); }}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl outline-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 p-4">
          <div>
            <h2 className="text-sm font-semibold text-white">{title}</h2>
            <p className="text-xs text-slate-400">
              {stage === STAGE_DONE
                ? 'This change has been applied to Azure.'
                : 'Review what will change before confirming.'}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {loading && (
            <p className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 size={14} className="animate-spin" />
              Checking with Azure…
            </p>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-950/30 p-3">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-xs leading-relaxed text-red-200">{error}</p>
            </div>
          )}

          {stage === STAGE_DONE && result && (
            <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-3">
              <Check size={14} className="mt-0.5 shrink-0 text-emerald-400" />
              <div>
                <p className="text-xs font-medium text-emerald-200">{result.message}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-emerald-200/70">
                  Recorded in the change history. Azure can take a few minutes to
                  apply access everywhere, so this page may still show the old
                  value until the next scan.
                </p>
              </div>
            </div>
          )}

          {preview && stage !== STAGE_DONE && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Who">
                  {preview.principal_name || (
                    <span className="text-slate-400">
                      Not named
                      <span className="ml-1 font-mono text-[11px] text-slate-500">
                        {preview.principal_id?.slice(0, 8)}…
                      </span>
                    </span>
                  )}
                </Field>
                <Field label="Role">{preview.role_name || 'Not named'}</Field>
                <Field label="Where">
                  <span className="capitalize">{preview.scope_kind}</span>
                </Field>
                <Field label="Action">
                  <span className="capitalize">{verb}</span>
                </Field>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-800/30 p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  What this means
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-300">{preview.effect}</p>
              </div>

              <div className="space-y-2.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Checks
                </p>
                {(preview.checks || []).map(item => (
                  <CheckRow key={item.key} item={item} />
                ))}
              </div>

              {preview.permission?.status === 'unverified' && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-950/30 p-3">
                  <Lock size={14} className="mt-0.5 shrink-0 text-amber-400" />
                  <p className="text-xs leading-relaxed text-amber-200">
                    Azure did not confirm whether you may change access here, so
                    this has not been attempted. That is a failed check, not a
                    refusal — try again in a moment.
                  </p>
                </div>
              )}

              {needsTyping && (
                <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-3">
                  <div className="flex items-start gap-2">
                    <ShieldAlert size={14} className="mt-0.5 shrink-0 text-red-400" />
                    <p className="text-xs leading-relaxed text-red-200">
                      This role can control access for everyone else. Type{' '}
                      <span className="font-semibold">{target}</span> to confirm
                      you mean this account.
                    </p>
                  </div>
                  <input
                    value={typed}
                    onChange={e => setTyped(e.target.value)}
                    aria-label="Type the account name to confirm"
                    className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-red-500/50"
                    placeholder={target}
                  />
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-800 p-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            {stage === STAGE_DONE ? 'Done' : 'Cancel'}
          </button>
          {stage !== STAGE_DONE && (
            <button
              onClick={run}
              disabled={!canApply || stage === STAGE_WORKING}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                canApply && stage !== STAGE_WORKING
                  ? 'bg-red-600 text-white hover:bg-red-500'
                  : 'cursor-not-allowed bg-slate-800 text-slate-500'
              }`}
            >
              {stage === STAGE_WORKING && <Loader2 size={13} className="animate-spin" />}
              {stage === STAGE_WORKING ? 'Applying…' : `Confirm & ${verb}`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
