import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, X, Send, Loader2, Sparkles, ShieldCheck } from 'lucide-react';

import { sendProvisionChat, fetchIntegrations } from '../../api/client';
import { errorMessage } from '../../utils/apiError';
import { useAppStore } from '../../store/useAppStore';

/**
 * The ask-anything assistant, as a bubble rather than a destination.
 *
 * Questions about spend arrive while you are looking at spend, so making
 * someone leave the page they are reading to ask about it loses the very
 * context that prompted the question. It sits in the corner instead, closed
 * until it is wanted.
 *
 * Read-only by construction: it sends mode 'ask', and the server gives that
 * conversation no tools that change anything. Building stays on its own page,
 * behind a Create button, where it is deliberately harder to reach by accident.
 */

const SUGGESTIONS = [
  'Which subscriptions can I see?',
  'What did we spend last month, by service?',
  'What is running right now?',
];

function Bubble({ role, content }) {
  const mine = role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[88%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words',
          mine
            ? 'bg-sky-600 text-white rounded-br-sm'
            : 'bg-slate-100 text-slate-800 rounded-bl-sm',
        ].join(' ')}
      >
        {content}
      </div>
    </div>
  );
}

export default function AssistantWidget() {
  const me = useAppStore(s => s.me);
  const selectedTenantId = useAppStore(s => s.selectedTenantId);

  const [open, setOpen] = useState(false);
  const [integrations, setIntegrations] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const endRef = useRef(null);
  const inputRef = useRef(null);

  // Only asked for once the panel is opened. Someone who never opens this
  // should not be paying for a request they did not ask for.
  useEffect(() => {
    if (!open || integrations !== null) return;
    fetchIntegrations().then(setIntegrations).catch(() => setIntegrations([]));
  }, [open, integrations]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const canAdminister = me?.can_administer !== false;
  // An endpoint with no daily limit is not configured yet: nobody has said how
  // much of the customer's money this is allowed to spend.
  const ready = integrations === null
    ? null
    : integrations.some(i => i.enabled && i.has_key && i.rate_limit_per_day > 0);

  const send = async (text) => {
    const message = (text ?? input).trim();
    if (!message || sending) return;
    setInput('');
    setError('');
    const history = messages.map(m => ({ role: m.role, content: m.content }));
    setMessages(m => [...m, { role: 'user', content: message }]);
    setSending(true);
    try {
      const result = await sendProvisionChat({
        message,
        history,
        currency: 'INR',
        tenant_id: selectedTenantId || '',
        mode: 'ask',
      });
      setMessages(m => [...m, { role: 'assistant', content: result.answer }]);
    } catch (err) {
      setError(errorMessage(err));
      // Give the question back rather than losing what they typed.
      setMessages(m => m.slice(0, -1));
      setInput(message);
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask about your Azure"
        title="Ask about your Azure"
        className="fixed bottom-5 right-5 z-40 h-[52px] w-[52px] rounded-full bg-sky-600 text-white shadow-lg shadow-sky-900/30 flex items-center justify-center hover:bg-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-300"
      >
        <MessageCircle size={22} />
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Ask about your Azure"
      className="fixed z-40 bg-white border border-slate-200 shadow-2xl flex flex-col
                 inset-x-3 bottom-3 rounded-2xl max-h-[80vh]
                 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[380px] sm:h-[560px] sm:max-h-[78vh]"
    >
      <header className="flex items-start gap-2 px-4 py-3 border-b border-slate-100">
        <MessageCircle size={16} className="text-sky-600 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">Ask about your Azure</p>
          <p className="text-[11px] text-slate-500 flex items-center gap-1">
            <ShieldCheck size={11} className="shrink-0" />
            Read-only. To build, use{' '}
            <Link
              to="/deploy"
              onClick={() => setOpen(false)}
              className="text-sky-700 underline underline-offset-2"
            >
              Deployment
            </Link>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="text-slate-400 hover:text-slate-600 shrink-0"
        >
          <X size={16} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {ready === false && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <p className="font-medium">No model endpoint is ready yet.</p>
            <p className="mt-1">
              It needs an endpoint that is enabled, has a key, and has a daily
              request limit above zero. That limit caps what this may spend, so
              it is never set for you.
            </p>
            {canAdminister ? (
              <Link
                to="/settings"
                onClick={() => setOpen(false)}
                className="inline-block mt-2 font-medium underline underline-offset-2"
              >
                Open Settings → Integrations
              </Link>
            ) : (
              <p className="mt-2">Ask an administrator to set one up.</p>
            )}
          </div>
        )}

        {messages.length === 0 && !sending && ready !== false && (
          <div className="text-center py-6">
            <Sparkles size={18} className="mx-auto text-slate-300" />
            <p className="text-xs text-slate-500 mt-2">
              Answers come from your own account. Anything it will not report is
              shown as “Not available”, never guessed.
            </p>
            <div className="flex flex-col gap-1.5 mt-3">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:border-sky-300 hover:text-sky-700"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <Bubble key={i} role={m.role} content={m.content} />
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 size={12} className="animate-spin" />
            Reading your account…
          </div>
        )}

        {error && (
          <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="flex items-end gap-2 p-3 border-t border-slate-100"
        onSubmit={(e) => { e.preventDefault(); send(); }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder="Ask about subscriptions, spend or resources…"
          className="flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-200"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          aria-label="Send"
          className="rounded-xl bg-sky-600 text-white px-3 py-2 disabled:opacity-40"
        >
          <Send size={15} />
        </button>
      </form>
    </div>
  );
}
