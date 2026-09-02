import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Copy, ExternalLink, Loader2, Terminal } from 'lucide-react';
import { cancelCliLogin, fetchCliLogin, startCliLogin } from '../../api/client';
import Modal from '../Common/Modal';
import toast from 'react-hot-toast';

const DEVICE_URL = 'https://microsoft.com/devicelogin';

/**
 * Sign the machine's Azure CLI in, from here.
 *
 * The point of this dialog is that it asks for nothing. No client secret, no
 * pasted token, no expiry to keep an eye on -- a short code typed into
 * Microsoft's own page, in the browser the person is already signed in to. It
 * is the same device-code flow the CLI would print in a terminal; all this
 * does is put the code where they are already looking.
 *
 * Once it succeeds every tenant that account can reach becomes readable, and
 * stays readable, because the CLI refreshes its own token from then on.
 */
export default function AzureCliLoginModal({ onClose, onSignedIn }) {
  const [state, setState] = useState('starting');
  const [code, setCode] = useState('');
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  const apply = useCallback((data) => {
    setState(data?.state || 'idle');
    setCode(data?.code || '');
    setUrl(data?.url || DEVICE_URL);
    setMessage(data?.message || '');
    return data?.state;
  }, []);

  useEffect(() => {
    let alive = true;

    // Polling, not a socket. The wait is bounded by how long a person takes to
    // type nine characters, and a two-second poll is cheaper to reason about
    // than a connection that has to survive a backend restart.
    const poll = async () => {
      try {
        const data = await fetchCliLogin();
        if (!alive) return;
        const next = apply(data);
        if (next === 'starting' || next === 'pending') {
          timer.current = setTimeout(poll, 2000);
        } else if (next === 'complete') {
          onSignedIn?.();
        }
      } catch {
        if (alive) {
          setState('failed');
          setMessage('Lost contact with the service while signing in.');
        }
      }
    };

    (async () => {
      try {
        const data = await startCliLogin();
        if (!alive) return;
        if (apply(data) !== 'complete') timer.current = setTimeout(poll, 1500);
        else onSignedIn?.();
      } catch (err) {
        if (!alive) return;
        setState('failed');
        setMessage(err.response?.data?.detail || err.message);
      }
    })();

    return () => {
      alive = false;
      clearTimeout(timer.current);
    };
  }, [apply, onSignedIn]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not reach the clipboard — read the code across by hand.');
    }
  };

  // Closing without finishing leaves an `az` process waiting on the server for
  // a code nobody is going to enter, so the dialog takes it with it.
  const close = async () => {
    if (state === 'starting' || state === 'pending') {
      try { await cancelCliLogin(); } catch { /* it will time out on its own */ }
    }
    onClose();
  };

  return (
    <Modal onClose={close} title="Sign in with the Azure CLI">
      <div className="space-y-4">
        <p className="text-xs text-slate-400">
          This signs in the Azure CLI on the machine running this service. Once
          it is done, every tenant that account can reach is readable with no
          service principal and no session token to keep refreshing.
        </p>

        {state === 'starting' && (
          <div className="flex items-center gap-2 text-sm text-slate-300">
            <Loader2 className="w-4 h-4 animate-spin" />
            Asking the CLI for a sign-in code…
          </div>
        )}

        {state === 'pending' && (
          <>
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
              <p className="text-xs text-slate-400 mb-2">
                Open the Microsoft sign-in page and enter this code:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-lg bg-slate-900 px-3 py-2 font-mono text-lg tracking-[0.2em] text-white">
                  {code}
                </code>
                <button
                  onClick={copyCode}
                  className="rounded-lg border border-slate-700 p-2 text-slate-300 transition hover:border-slate-600 hover:text-white"
                  title="Copy the code"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <a
                href={url || DEVICE_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                {url || DEVICE_URL}
              </a>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Waiting for you to finish signing in…
            </div>
          </>
        )}

        {state === 'complete' && (
          <div className="flex items-start gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{message || 'Signed in.'}</span>
          </div>
        )}

        {state === 'failed' && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="whitespace-pre-wrap">{message || 'The sign-in failed.'}</span>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-slate-800 pt-3">
          <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <Terminal className="w-3.5 h-3.5" />
            Your password is entered at Microsoft — it never passes through this app.
          </p>
          <button
            onClick={close}
            className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:border-slate-600 hover:text-white"
          >
            {state === 'complete' ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
