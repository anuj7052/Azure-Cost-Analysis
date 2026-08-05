"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  ErrorState,
  Skeleton,
} from "@/components/ui/primitives";
import { api, type AssistantAnswer } from "@/lib/api";

const SUGGESTIONS = [
  "Why did my Azure bill increase?",
  "Which resources are unused?",
  "Which VMs should be resized?",
  "Show my highest-cost resources.",
  "Summarize today's alerts.",
];

export default function AssistantPage() {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<
    { question: string; answer: AssistantAnswer }[]
  >([]);

  const ask = useMutation({
    mutationFn: (q: string) => api.askAssistant(q),
    onSuccess: (answer, q) => {
      setHistory((prev) => [...prev, { question: q, answer }]);
      setQuestion("");
    },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Assistant</h1>
      <p className="text-sm text-muted-foreground">
        Answers are grounded in your synced Azure data only. The assistant cannot
        change anything in your subscriptions.
      </p>

      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <Button key={s} variant="outline" onClick={() => ask.mutate(s)}>
            {s}
          </Button>
        ))}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim().length > 2) ask.mutate(question.trim());
        }}
      >
        <input
          className="h-10 flex-1 rounded-md border bg-background px-3 text-sm"
          placeholder="Ask about cost, usage, alerts or a resource…"
          value={question}
          maxLength={1000}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button type="submit" disabled={ask.isPending}>
          Ask
        </Button>
      </form>

      {ask.error ? <ErrorState message={(ask.error as Error).message} /> : null}

      <div className="space-y-3">
        {history.map((entry, index) => (
          <Card key={index}>
            <CardContent className="space-y-2 pt-5">
              <p className="text-sm font-medium">{entry.question}</p>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {entry.answer.answer}
              </p>
              {entry.answer.used_tools.length ? (
                <div className="flex flex-wrap gap-1">
                  {entry.answer.used_tools.map((tool) => (
                    <Badge key={tool}>{tool}</Badge>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))}
        {ask.isPending ? <Skeleton className="h-24" /> : null}
      </div>
    </div>
  );
}
