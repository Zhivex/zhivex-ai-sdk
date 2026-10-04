"use client";

import { useState } from "react";
import { ReviewCard, ZhivexChat, useExternalChat, type ChatMessage, type ChatState } from "@zhivex-ai/react";

interface Snapshot {
  sessionId: string;
  transcript: ChatMessage[];
  activity: string[];
  review?: { id: string; token: object };
}

/** Offline fixture standing in for the host's existing durable store. */
export function createOfflineHost() {
  let snapshot: Snapshot = { sessionId: "offline", transcript: [], activity: ["Offline host ready"] };
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    async send(text: string) {
      const id = String(snapshot.transcript.length);
      publish({ ...snapshot,
        transcript: [...snapshot.transcript,
          { id: `user-${id}`, role: "user", parts: [{ type: "text", text }], createdAt: Date.now(), status: "complete" },
          { id: `assistant-${id}`, role: "assistant", parts: [{ type: "text", text: "This offline reply comes from the host snapshot." }], createdAt: Date.now(), status: "complete" }],
        activity: [...snapshot.activity, "Host published a reply"],
        review: { id: `review-${id}`, token: {} }
      });
    },
    async review(token: object, approved: boolean) {
      if (token !== snapshot.review?.token) throw new Error("Review is no longer current.");
      publish({ ...snapshot, review: undefined,
        activity: [...snapshot.activity, approved ? "Host accepted review" : "Host rejected review"] });
    }
  };
}

const selectState = (snapshot: Snapshot): ChatState => ({
  sessionId: snapshot.sessionId,
  messages: snapshot.transcript,
  status: "ready",
  pendingApprovals: [],
  activity: []
});

const unsupported = async () => { throw new Error("This host does not provide that operation."); };

export function OfflineChat({ host }: { host: ReturnType<typeof createOfflineHost> }) {
  const [input, setInput] = useState("");
  const { controller, snapshot } = useExternalChat({
    store: host,
    selectState,
    actions: { input, setInput, async send(text = input) {
      await host.send(text);
      setInput("");
    }, stop() {}, reload: unsupported, canReload: false, resolveApproval: unsupported }
  });
  return <ZhivexChat controller={controller}
    runtimeActivity={<ol aria-label="Host activity">{snapshot.activity.map((entry, index) => <li key={index}>{entry}</li>)}</ol>}
    reviews={snapshot.review ? <ReviewCard
      reviewId={`${snapshot.sessionId}:${snapshot.review.id}`}
      heading="Accept the offline result"
      description="This callback belongs to the host; no SDK approval request is created."
      reasonMode="never"
      onDecision={(approved) => host.review(snapshot.review!.token, approved)}
    /> : null}
  />;
}
