import { OmniChat, VoiceChat } from "../../../examples/react-omni/app.js";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ZhivexChat, type MessagePartRenderers } from "../src/components";
import { createFetchChatTransport } from "../src/transport";
import { useZhivexChat } from "../src/use-zhivex-chat";
import { VirtualizedMessageList } from "../src/virtualized";
import { MarkdownMessagePart } from "../src/markdown";
import type { ChatMessage } from "../src/types";
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
createRoot(document.getElementById("root")!).render(view === "omni" ? <OmniChat /> : view === "voice" ? <VoiceChat /> : <App />);
