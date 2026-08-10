"use client";

import { useMutation } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
} from "@/components/ui/primitives";
import {
  api,
  ApiError,
  type Boq,
  type BoqChatAnswer,
  type ChatArtifact,
  type ChatTurn,
  type IacFormat,
  type IacPlan,
} from "@/lib/api";

const SUGGESTIONS = [
  "Implement this BOQ",
  "Generate Terraform for this estimate",
  "What is in this BOQ?",
  "Which lines could not be turned into resources?",
  "What will this cost per month?",
];

type Message = ChatTurn & { artifacts?: ChatArtifact[]; tools?: string[] };

function money(value: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function download(artifact: ChatArtifact) {
  const url = URL.createObjectURL(
    new Blob([artifact.content], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = artifact.filename;
  link.click();
  URL.revokeObjectURL(url);
}

function PlanSummary({ plan }: { plan: IacPlan }) {
  const uncovered = plan.total_monthly_cost - plan.covered_monthly_cost;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recovered from the estimate</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Badge>{plan.resources.length} resources</Badge>
          <Badge>{plan.location}</Badge>
          <Badge>{plan.resource_group}</Badge>
          {plan.needs_review.length > 0 ? (
            <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-600">
              {plan.needs_review.length} need review
            </Badge>
          ) : null}
        </div>

        <table className="w-full tabular-nums">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="py-1 text-left font-medium">Resource</th>
              <th className="py-1 text-left font-medium">Kind</th>
              <th className="py-1 text-left font-medium">SKU</th>
              <th className="py-1 text-right font-medium">Size</th>
              <th className="py-1 text-right font-medium">Qty</th>
              <th className="py-1 text-right font-medium">Cost/month</th>
            </tr>
          </thead>
          <tbody>
            {plan.resources.map((r) => (
              <tr key={r.name} className="border-b last:border-0">
                <td className="py-1 font-medium">{r.name}</td>
                <td className="py-1 text-muted-foreground">
                  {r.kind.replace(/_/g, " ")}
                </td>
                <td className="py-1 text-muted-foreground">{r.sku || "—"}</td>
                <td className="py-1 text-right text-muted-foreground">
                  {r.size_gib ? `${r.size_gib} GiB` : "—"}
                </td>
                <td className="py-1 text-right">{r.count}</td>
                <td className="py-1 text-right">
                  {money(r.monthly_cost, plan.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="text-xs text-muted-foreground">
          The template covers {money(plan.covered_monthly_cost, plan.currency)}{" "}
          of the {money(plan.total_monthly_cost, plan.currency)} estimate.
          {uncovered > 0
            ? ` ${money(uncovered, plan.currency)} sits on lines that need review.`
            : ""}
        </p>

        {plan.needs_review.length > 0 ? (
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-xs font-medium">
              Show the {plan.needs_review.length} lines that need review
            </summary>
            <ul className="mt-2 space-y-2">
              {plan.needs_review.map((line, i) => (
                <li key={`${line.service_type}-${i}`} className="text-xs">
                  <span className="font-medium">{line.service_type}</span>
                  {line.custom_name ? ` · ${line.custom_name}` : ""}
                  <span className="ml-1 text-muted-foreground">
                    {money(line.monthly_cost, plan.currency)} — {line.reason}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function BoqPage() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [boq, setBoq] = useState<Boq | null>(null);
  const [plan, setPlan] = useState<IacPlan | null>(null);
  const [resourceGroup, setResourceGroup] = useState("rg-boq");
  const [format, setFormat] = useState<IacFormat>("bicep");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);

  const history = useMemo<ChatTurn[]>(
    () => messages.map(({ role, content }) => ({ role, content })),
    [messages],
  );

  const upload = useMutation({
    mutationFn: async (picked: File) => {
      const parsed = await api.parseBoq(picked);
      return { parsed, plan: await api.planBoq(picked, resourceGroup) };
    },
    onSuccess: ({ parsed, plan: built }) => {
      setBoq(parsed);
      setPlan(built);
      setMessages([]);
    },
  });

  const generate = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("Upload an estimate first.");
      return api.generateIac(file, format, resourceGroup);
    },
    onSuccess: (template) => download(template),
  });

  const chat = useMutation({
    mutationFn: (text: string) =>
      api.chatAboutBoq({
        message: text,
        boq,
        history,
        resource_group: resourceGroup,
      }),
    onMutate: (text: string) => {
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setMessage("");
    },
    onSuccess: (answer: BoqChatAnswer) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: answer.answer,
          artifacts: answer.artifacts,
          tools: answer.used_tools,
        },
      ]);
    },
  });

  const errorOf = (e: unknown) =>
    e instanceof ApiError || e instanceof Error ? e.message : "Something failed.";

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">BOQ to infrastructure</h1>
        <p className="text-sm text-muted-foreground">
          Upload an Azure Pricing Calculator estimate to get reviewable Bicep or
          Terraform. Templates are generated for you to run — nothing is ever
          deployed into your subscription from here.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 pt-5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.xlsx,.xlsm"
              className="text-sm"
              onChange={(e) => {
                const picked = e.target.files?.[0] ?? null;
                setFile(picked);
                if (picked) upload.mutate(picked);
              }}
            />
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Resource group</span>
              <input
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={resourceGroup}
                maxLength={90}
                onChange={(e) => setResourceGroup(e.target.value)}
              />
            </label>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={format}
              onChange={(e) => setFormat(e.target.value as IacFormat)}
            >
              <option value="bicep">Bicep</option>
              <option value="terraform">Terraform</option>
            </select>
            <Button
              onClick={() => generate.mutate()}
              disabled={!file || generate.isPending}
            >
              {generate.isPending ? "Generating…" : "Download template"}
            </Button>
          </div>

          {boq ? (
            <p className="text-xs text-muted-foreground">
              {boq.name} · {boq.items.length} priced lines ·{" "}
              {money(boq.total_monthly, boq.currency)} per month
            </p>
          ) : null}

          {upload.isPending ? (
            <p className="text-xs text-muted-foreground">Reading the estimate…</p>
          ) : null}
          {upload.error ? <ErrorState message={errorOf(upload.error)} /> : null}
          {generate.error ? (
            <ErrorState message={errorOf(generate.error)} />
          ) : null}
        </CardContent>
      </Card>

      {plan ? <PlanSummary plan={plan} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Ask for changes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <Button
                key={s}
                variant="outline"
                disabled={chat.isPending}
                onClick={() => chat.mutate(s)}
              >
                {s}
              </Button>
            ))}
          </div>

          {messages.length === 0 ? (
            <EmptyState
              title="No messages yet"
              hint={
                boq
                  ? "Say “implement this BOQ” to generate a template."
                  : "Upload an estimate first, then ask for a template."
              }
            />
          ) : (
            <ul className="space-y-3">
              {messages.map((m, i) => (
                <li
                  key={i}
                  className={
                    m.role === "user"
                      ? "rounded-md bg-muted p-3 text-sm"
                      : "rounded-md border p-3 text-sm"
                  }
                >
                  <p className="whitespace-pre-wrap">{m.content}</p>
                  {m.artifacts?.length ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {m.artifacts.map((a) => (
                        <Button
                          key={a.format}
                          variant="outline"
                          onClick={() => download(a)}
                        >
                          Download {a.filename}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  {m.tools?.length ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Used: {m.tools.join(", ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {chat.isPending ? (
            <p className="text-xs text-muted-foreground">Thinking…</p>
          ) : null}
          {chat.error ? <ErrorState message={errorOf(chat.error)} /> : null}

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const text = message.trim();
              if (text && !chat.isPending) chat.mutate(text);
            }}
          >
            <input
              className="h-10 flex-1 rounded-md border bg-background px-3 text-sm"
              placeholder="e.g. implement this BOQ as Terraform"
              value={message}
              maxLength={2000}
              onChange={(e) => setMessage(e.target.value)}
            />
            <Button type="submit" disabled={chat.isPending}>
              Send
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
