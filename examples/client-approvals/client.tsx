import { useApproval, useObject, type ApprovalPause } from "@zhivex-ai/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";

const readEvents = async (
  response: Response,
  onEvent: (event: { type?: string; delta?: string; message?: string }) => void
) => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body.");
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (raw: string) => {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return;
    onEvent(JSON.parse(data) as { type?: string; delta?: string; message?: string });
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let match = buffer.match(/\r?\n\r?\n/);
    while (match) {
      const index = match.index ?? 0;
      flush(buffer.slice(0, index));
      buffer = buffer.slice(index + match[0].length);
      match = buffer.match(/\r?\n\r?\n/);
    }
    if (done) {
      if (buffer.trim()) flush(buffer);
      break;
    }
  }
};

const card = {
  border: "1px solid #d0d7de",
  borderRadius: 8,
  padding: 16,
  marginBottom: 16
} as const;

export const App = () => {
  const approvals = useApproval({ api: "/api/approvals" });
  const object = useObject<{ priority?: string; team?: string; summary?: string }>({ api: "/api/object" });
  const [transcript, setTranscript] = useState("");
  const [notice, setNotice] = useState("The deploy tool pauses until you approve it.");

  const deploy = async () => {
    setTranscript("");
    setNotice("Running.");
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ prompt: "deploy staging" })
    });
    await readEvents(response, (event) => {
      approvals.receiveEvent(event);
      if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) {
        setTranscript((current) => current + event.delta);
      }
      if (event.type === "zhivex.approval.pause") {
        setNotice("Approval required before the tool runs.");
      }
      if (event.type === "RUN_ERROR") setNotice(event.message ?? "The run failed.");
    });
  };

  const decide = async (pause: ApprovalPause, approve: boolean) => {
    if (approve) await approvals.approve(pause.approvalRequestId, "reviewed", pause.provider);
    else await approvals.reject(pause.approvalRequestId, "rejected", pause.provider);
    setNotice(approve ? "Decision sent. The server verifies it before resuming." : "Rejection sent.");
  };

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 720, margin: "32px auto" }}>
      <h1>Client approvals and streaming objects</h1>
      <p>This page uses a mock model. It does not call a live provider.</p>
      <section style={card}>
        <h2>Governed deploy</h2>
        <button type="button" onClick={() => void deploy()}>Run deploy</button>
        <p>{notice}</p>
        <p>{transcript}</p>
        {approvals.pending.map((pause) => (
          <article key={`${pause.provider}:${pause.approvalRequestId}`}>
            <p>Approve {pause.name}?</p>
            <button type="button" onClick={() => void decide(pause, true)} disabled={approvals.submitting}>Approve</button>
            <button type="button" onClick={() => void decide(pause, false)} disabled={approvals.submitting}>Reject</button>
          </article>
        ))}
        {approvals.lastResult?.outputText ? <p>Result: {approvals.lastResult.outputText}</p> : null}
        {approvals.error ? <p>{approvals.error.message}</p> : null}
      </section>
      <section style={card}>
        <h2>Streaming object</h2>
        <button type="button" onClick={() => void object.submit({ prompt: "Triage a disk alert." })} disabled={object.isLoading}>
          Stream triage
        </button>
        <pre>{JSON.stringify(object.object ?? {}, null, 2)}</pre>
        {object.error ? <p>{object.error.message}</p> : null}
      </section>
    </main>
  );
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
