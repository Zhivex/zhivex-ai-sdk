import { OmniChat, VoiceChat } from "../../../examples/react-omni/app.js";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReviewCard, ZhivexChat, type MessagePartRenderers } from "../src/components";
import { useExternalChat } from "../src/use-external-chat";
import { createFetchChatTransport } from "../src/transport";
import { useZhivexChat } from "../src/use-zhivex-chat";
import { VirtualizedMessageList } from "../src/virtualized";
import { MarkdownMessagePart } from "../src/markdown";
import type { ChatMessage, ChatState } from "../src/types";
import "../styles.css";
const view = new URLSearchParams(location.search).get("view");
const renderers: MessagePartRenderers = { text: MarkdownMessagePart };
const initialMessages: ChatMessage[] = view === "virtual" ? Array.from({ length: 1000 }, (_, i) => ({
  id: `history-${i}`, role: "assistant", parts: [{ type: "text", text: `History ${i}\n${"variable height content ".repeat(i % 8 + 1)}` }], createdAt: i, status: "complete"
})) : view === "markdown" ? [{ id: "md", role: "assistant", status: "complete", createdAt: 1,
  parts: [{ type: "text", text: "| Name | Value |\n| --- | --- |\n| A | 42 |\n\n```ts\nconst answer = 42;\n```" }] }] : [];
function App() {
  const transport = useMemo(() => createFetchChatTransport({ endpoint: "/chat", reconnectEndpoint: "/chat", cancelEndpoint: "/chat",
    headers: { "x-disconnect": String(view === "disconnect"), "x-slow": String(view === "markdown") } }), []);
  const chat = useZhivexChat({ transport, initialMessages, maxReconnectAttempts: 2 });
  return <main style={{ maxWidth: 800, margin: "20px auto" }}>
    <ZhivexChat controller={chat} renderers={renderers}
      MessageListComponent={view === "virtual" ? VirtualizedMessageList : undefined}
      messageListProps={{ style: { height: 420, overflowY: "auto" } }}
      composerProps={{ accept: ".txt,image/*", uploadAttachment: view === "upload" ? async (file, { signal, onProgress }) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
          onProgress(0.5);
        });
        return { type: "file", filename: file.name, mediaType: file.type, data: "https://files.example/uploaded" };
      } : undefined }} />
    <output aria-label="Chat status">{chat.status}</output>
  </main>;
}
function ExternalLayout() {
  const params = new URLSearchParams(location.search);
  const enabled = (name: string) => params.get(name) === "1";
  const [input, setInput] = useState("");
  const [decision, setDecision] = useState("");
  const [sent, setSent] = useState("");
  const state = useMemo<ChatState>(() => ({
    status: "ready", pendingApprovals: [], activity: [],
    messages: Array.from({ length: 200 }, (_, i) => ({
      id: `external-${i}`, role: "assistant", createdAt: i, status: "complete",
      parts: [{ type: "text", text: `External history ${i}: ${"Long transcript content. ".repeat(8)}` }]
    })),
    runs: enabled("runs") ? [{ runId: "host-run", name: "Host execution", status: "completed", currentStep: 1, maxSteps: 2 }] : [],
    error: enabled("error") ? new Error("Offline host error") : undefined
  }), []);
  const store = useMemo(() => ({ getSnapshot: () => state, subscribe: () => () => {} }), [state]);
  const { controller } = useExternalChat({ store, selectState: (snapshot) => snapshot,
    actions: { input, setInput, async send(text = input) { setSent(text); setInput(""); },
      stop() {}, async reload() {}, canReload: false, async resolveApproval() {} }
  });
  return <main style={{ maxWidth: 800, margin: "20px auto" }}>
    <ZhivexChat controller={controller} style={{ height: 720 }}
      messageListProps={{ showMessageActions: false, autoFollow: false }}
      header={enabled("header") ? "External runtime chat" : undefined}
      runtimeActivity={enabled("activity") ? <>
        <div aria-label="Host activity">Host activity</div>
        <div aria-label="Host checkpoint">Checkpoint confirmed</div>
      </> : undefined}
      reviews={enabled("reviews") ? <ReviewCard reviewId="host-review" heading="Host review"
        reasonMode="never" onDecision={async (approved) => { setDecision(approved ? "accepted" : "rejected"); }} /> : undefined}
    />
    <output aria-label="Host decision">{decision}</output>
    <output aria-label="Host sent message">{sent}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(view === "external-layout" ? <ExternalLayout /> : view === "omni" ? <OmniChat /> : view === "voice" ? <VoiceChat /> : <App />);
