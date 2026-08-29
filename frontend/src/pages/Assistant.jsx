import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Send, Loader2, Sparkles, ShieldCheck } from 'lucide-react';

import { sendProvisionChat, fetchIntegrations } from '../api/client';
import { errorMessage } from '../utils/apiError';
import { useAppStore } from '../store/useAppStore';

// Deliberately all questions. This assistant has no drafting tools at all, so
// suggesting a build here would only teach people to ask for something it will
// have to refuse.
const SUGGESTIONS = [
  'Which subscriptions can I see?',
  'What did we spend last month, by service?',
  'What is running in my subscription right now?',
  'Which resource group cost the most over the last three months?',
];

function Bubble({ role, content }) {
  const mine = role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words',
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

export default function Assistant() {
  const me = useAppStore(s => s.me);
  const selectedTenantId = useAppStore(s => s.selectedTenantId);

  const [integrations, setIntegrations] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    fetchIntegrations().then(setIntegrations).catch(() => setIntegrations([]));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const canAdminister = me?.can_administer !== false;
  // A registered endpoint with no daily limit is not configured yet: nobody
  // has said how much of the customer's money this may spend.
  const ready = integrations === null
    ? null
    : integrations.some(i => i.enabled && i.has_key && i.rate_limit_per_day > 0);
  const exhausted = (integrations || []).some(
    i => i.enabled && i.has_key && i.rate_limit_per_day > 0 && i.remaining_today === 0,
  );

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
        // Read-only. The server decides what this means; asking for it here
        // only ever narrows what the assistant is given.
        mode: 'ask',
      });
      setMessages(m => [...m, { role: 'assistant', content: result.answer }]);
    } catch (err) {
      setError(errorMessage(err));
      // Put the question back in the box rather than losing what they typed.
      setMessages(m => m.slice(0, -1));
      setInput(message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
          <MessageCircle size={18} className="text-sky-600" />
          Ask about your Azure
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          Questions about the subscriptions, spend and resources you already
          have. Answers come from your own account, and anything the account
          will not report is shown as “Not available” rather than guessed.
        </p>
        <p className="text-xs text-slate-500 mt-1 flex items-center gap-1.5">
          <ShieldCheck size={13} className="text-slate-400 shrink-0" />
          This assistant is read-only. To create something, use{' '}
          <Link to="/deploy" className="text-sky-700 underline underline-offset-2">
            the deployment assistant
          </Link>.
        </p>
      </header>

      {ready === false && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">No model endpoint is ready yet.</p>
          <p className="mt-1 text-xs">
            The assistant needs an endpoint that is enabled, has a key, and has
            a daily request limit above zero. The limit is how you cap what this
            may spend, so it is never set for you.
          </p>
          {canAdminister ? (
            <Link
              to="/settings"
              className="inline-block mt-2 text-xs font-medium text-amber-900 underline underline-offset-2"
            >
              Open Settings → Integrations
            </Link>
          ) : (
            <p className="mt-2 text-xs">
              Ask the workspace owner or an administrator to set one up.
            </p>
          )}
        </div>
      )}

      {exhausted && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 mb-3">
          One of your endpoints has used its whole daily allowance.
        </div>
      )}

      {ready !== false && (
        <>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 min-h-[18rem] space-y-3">
            {messages.length === 0 && !sending && (
              <div className="text-center py-8">
                <Sparkles size={20} className="mx-auto text-slate-300" />
                <p className="text-sm text-slate-500 mt-2">
                  Ask anything about your Azure estate.
                </p>
                <div className="flex flex-wrap gap-2 justify-center mt-4">
                  {SUGGESTIONS.map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      className="text-xs px-3 py-1.5 rounded-full border border-slate-200 text-slate-600 hover:border-sky-300 hover:text-sky-700"
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
                <Loader2 size={13} className="animate-spin" />
                Reading your account…
              </div>
            )}
            <div ref={endRef} />
          </div>

          {error && (
            <p className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(e) => { e.preventDefault(); send(); }}
          >
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder="Ask about subscriptions, spend or resources…"
              className="flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-sky-200"
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="rounded-xl bg-sky-600 text-white px-4 py-2.5 text-sm font-medium disabled:opacity-40"
            >
              <Send size={15} />
            </button>
          </form>
        </>
      )}
    </div>
  );
}
