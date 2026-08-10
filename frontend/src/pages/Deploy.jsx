import { useMemo, useRef, useState } from 'react';
import { Upload, FileCode, Send, Download, AlertTriangle } from 'lucide-react';

import { uploadBoq, planBoq, generateIac, chatAboutBoq } from '../api/client';

const SUGGESTIONS = [
  'Implement this BOQ',
  'Generate Terraform for this estimate',
  'What is in this BOQ?',
  'Which lines could not be turned into resources?',
];

const KIND_LABELS = {
  managed_disk: 'Managed disk',
  virtual_machine: 'Virtual machine',
  storage_account: 'Storage account',
  public_ip: 'Public IP',
  virtual_network: 'Virtual network',
  recovery_vault: 'Recovery vault',
};

function money(value, currency) {
  if (value == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value).toLocaleString()}`;
  }
}

function download(artifact) {
  const url = URL.createObjectURL(
    new Blob([artifact.content], { type: 'text/plain;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = artifact.filename;
  link.click();
  URL.revokeObjectURL(url);
}

function errorText(err) {
  return err?.response?.data?.detail || err?.message || 'Something went wrong.';
}

function PlanTable({ plan }) {
  const uncovered = plan.total_monthly_cost - plan.covered_monthly_cost;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
      <h2 className="text-sm font-semibold text-white mb-1">
        Resources recovered from the estimate
      </h2>
      <p className="text-[11px] text-slate-400 mb-3">
        Deploying into <span className="font-medium text-slate-300">{plan.resource_group}</span> in{' '}
        <span className="font-medium text-slate-300">{plan.location}</span>.
      </p>

      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-slate-500 border-b border-slate-800">
            <th className="py-1.5 text-left font-medium">Resource</th>
            <th className="py-1.5 text-left font-medium">Kind</th>
            <th className="py-1.5 text-left font-medium">SKU</th>
            <th className="py-1.5 text-right font-medium">Size</th>
            <th className="py-1.5 text-right font-medium">Qty</th>
            <th className="py-1.5 text-right font-medium">Cost/month</th>
          </tr>
        </thead>
        <tbody>
          {plan.resources.map((r) => (
            <tr key={r.name} className="border-b border-slate-800 last:border-0">
              <td className="py-1.5 font-medium text-slate-200">{r.name}</td>
              <td className="py-1.5 text-slate-400">{KIND_LABELS[r.kind] || r.kind}</td>
              <td className="py-1.5 text-slate-400">{r.sku || '—'}</td>
              <td className="py-1.5 text-right text-slate-400">
                {r.size_gib ? `${r.size_gib} GiB` : '—'}
              </td>
              <td className="py-1.5 text-right text-slate-300">{r.count}</td>
              <td className="py-1.5 text-right text-slate-200">
                {money(r.monthly_cost, plan.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-[11px] text-slate-400 mt-3">
        The template covers {money(plan.covered_monthly_cost, plan.currency)} of the{' '}
        {money(plan.total_monthly_cost, plan.currency)} estimate.
        {uncovered > 0
          ? ` ${money(uncovered, plan.currency)} sits on lines that need review.`
          : ''}
      </p>

      {plan.needs_review.length > 0 && (
        <details className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
          <summary className="cursor-pointer text-[11px] font-medium text-amber-300 flex items-center gap-1.5">
            <AlertTriangle size={13} />
            {plan.needs_review.length} line(s) could not be turned into a resource
          </summary>
          <ul className="mt-2 space-y-1.5">
            {plan.needs_review.map((line, i) => (
              <li key={`${line.service_type}-${i}`} className="text-[11px] text-amber-200/90">
                <span className="font-medium">{line.service_type}</span>
                {line.custom_name ? ` · ${line.custom_name}` : ''} —{' '}
                {money(line.monthly_cost, plan.currency)}. {line.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function Deploy() {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [boq, setBoq] = useState(null);
  const [plan, setPlan] = useState(null);
  const [resourceGroup, setResourceGroup] = useState('rg-boq');
  const [format, setFormat] = useState('bicep');
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const history = useMemo(
    () => messages.map(({ role, content }) => ({ role, content })),
    [messages],
  );

  async function handleFile(picked) {
    if (!picked) return;
    setFile(picked);
    setError('');
    setBusy('Reading the estimate…');
    try {
      const parsed = await uploadBoq(picked);
      setBoq(parsed);
      setPlan(await planBoq(picked, resourceGroup));
      setMessages([]);
    } catch (err) {
      setError(errorText(err));
      setBoq(null);
      setPlan(null);
    } finally {
      setBusy('');
    }
  }

  async function handleGenerate() {
    if (!file) return;
    setError('');
    setBusy('Generating the template…');
    try {
      download(await generateIac(file, format, resourceGroup));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  async function send(text) {
    const trimmed = (text || '').trim();
    if (!trimmed || busy) return;
    setMessage('');
    setError('');
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    setBusy('Thinking…');
    try {
      const answer = await chatAboutBoq({
        message: trimmed,
        boq,
        history,
        resource_group: resourceGroup,
      });
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: answer.answer,
          artifacts: answer.artifacts,
          tools: answer.used_tools,
        },
      ]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-white">BOQ to infrastructure</h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Upload an Azure Pricing Calculator estimate to get reviewable Bicep or
          Terraform. Templates are generated for you to run — nothing is deployed
          into your subscription from here.
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xlsm,.xls"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-[#fff] hover:bg-blue-500 transition"
          >
            <Upload size={13} /> Upload estimate
          </button>

          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            Resource group
            <input
              value={resourceGroup}
              maxLength={90}
              onChange={(e) => setResourceGroup(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-white"
            />
          </label>

          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-white"
          >
            <option value="bicep">Bicep</option>
            <option value="terraform">Terraform</option>
          </select>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!file || !!busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            <FileCode size={13} /> Download template
          </button>
        </div>

        {boq && (
          <p className="text-[11px] text-slate-400">
            {boq.name} · {boq.items.length} priced lines ·{' '}
            {money(boq.total_monthly, boq.currency)} per month
          </p>
        )}
        {busy && <p className="text-[11px] text-slate-400">{busy}</p>}
        {error && (
          <p className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
            {error}
          </p>
        )}
      </div>

      {plan && <PlanTable plan={plan} />}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-white">Ask for changes</h2>

        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              disabled={!!busy}
              onClick={() => send(s)}
              className="rounded-full border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>

        {messages.length === 0 ? (
          <p className="text-[11px] text-slate-500 border border-dashed border-slate-700 rounded-xl p-5 text-center">
            {boq
              ? 'Say “implement this BOQ” to generate a template.'
              : 'Upload an estimate first, then ask for a template.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {messages.map((m, i) => (
              <li
                key={i}
                className={
                  m.role === 'user'
                    ? 'rounded-xl bg-slate-800 px-3 py-2 text-xs text-slate-100'
                    : 'rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300'
                }
              >
                <p className="whitespace-pre-wrap">{m.content}</p>
                {m.artifacts?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.artifacts.map((a) => (
                      <button
                        key={a.format}
                        type="button"
                        onClick={() => download(a)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-800"
                      >
                        <Download size={12} /> {a.filename}
                      </button>
                    ))}
                  </div>
                )}
                {m.tools?.length > 0 && (
                  <p className="mt-1.5 text-[10px] text-slate-500">
                    Used: {m.tools.join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(message);
          }}
        >
          <input
            value={message}
            maxLength={2000}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. implement this BOQ as Terraform"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white placeholder:text-slate-500"
          />
          <button
            type="submit"
            disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-medium text-[#fff] hover:bg-blue-500 disabled:opacity-40"
          >
            <Send size={13} /> Send
          </button>
        </form>
      </div>
    </div>
  );
}
