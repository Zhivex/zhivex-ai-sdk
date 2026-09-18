import { useMemo, useState } from "react";
import { useZhivexChat, createFetchChatTransport, ZhivexChat, ChatEmptyState } from "@zhivex-ai/react";
import { createWebSocketRealtimeTransport, useZhivexRealtime } from "@zhivex-ai/react/realtime";
import "../../packages/react/styles.css";
import "./styles.css";
const inputCapabilities = { vision: true, audioInput: true, files: true, inputMediaTypes: ["image/*", "audio/*", "video/*"] };

export function OmniChat() {
  const transport = useMemo(() => createFetchChatTransport({ endpoint: "/omni", reconnectEndpoint: "/omni", cancelEndpoint: "/omni", requestTimeoutMs: 180_000, streamIdleTimeoutMs: 60_000 }), []);
  const chat = useZhivexChat({ transport, inputCapabilities, maxReconnectAttempts: 2 });
  return <ZhivexChat mediaUrlPolicy={{ allowRemote: true, allowPrivateNetwork: true, allowUrl: url => url.origin === location.origin && url.pathname.startsWith("/omni/uploads/") }} controller={chat} header={<div className="omni-heading"><div><span className="omni-eyebrow">MULTIMODAL WORKSPACE</span><h1>Explore with Omni</h1></div><span className="omni-model">Qwen 3.8 Omni Flash</span></div>}
    emptyState={<ChatEmptyState title="Bring your ideas into focus." description="Ask a question, share a photo, or explore an audio or video clip. You stay in control of every agent action." starterPrompts={["What can I do with Omni?", "Help me analyze my media", "Consult context before answering"]} onStarterPrompt={prompt => { chat.setInput(prompt); document.querySelector<HTMLTextAreaElement>(".omni-chat textarea")?.focus(); }} />}
    className="omni-chat"
    composerProps={{ textareaProps: { placeholder: "Ask anything, or attach your media…" }, maxAttachmentBytes: 8 * 1024 * 1024, uploadAttachment: async (file, { signal, onProgress }) => {
      const response = await fetch("/omni/uploads", { method: "POST", body: file, signal, headers: { "content-type": file.type, "x-filename": encodeURIComponent(file.name) } });
      if (!response.ok) throw new Error("Upload failed.");
      const { reference } = await response.json(); onProgress(1);
      return file.type.startsWith("image/") ? { type: "image", image: reference, mediaType: file.type }
        : file.type.startsWith("audio/") ? { type: "audio", data: reference, mediaType: file.type, filename: file.name }
        : { type: "file", data: reference, mediaType: file.type, filename: file.name };
    } }} />;
}
export function VoiceChat() {
  const transport = useMemo(() => createWebSocketRealtimeTransport({ url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/voice` }), []);
  const voice = useZhivexRealtime({ transport });
  const [voiceText, setVoiceText] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const action = (operation: () => Promise<void>) => { setActionError(undefined); void operation().catch(error => setActionError(error instanceof Error ? error.message : "Voice action failed.")); };
  const connected = voice.status === "connected";
  return <section className="omni-voice zhivex-chat" aria-label="Realtime voice" data-microphone-active={voice.microphoneActive}>
    <div className="omni-heading"><div><span className="omni-eyebrow">VOICE CONVERSATION</span><h2>Talk it through.</h2></div><output className="omni-status" aria-label="Voice status" aria-live="polite" data-status={voice.status}>{voice.status}</output></div>
    <div className="omni-voice__body">
      <div className="omni-voice__signal" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6].map(i => <span key={i} />)}</div>
      <p>{voice.microphoneActive ? "Microphone on. Speak naturally — turn it off any time." : connected ? "You’re connected. Turn on your microphone when you’re ready." : "Start a live conversation. Your microphone stays off until you enable it."}</p>
      <div className="omni-voice__actions">
        <button className="zhivex-button zhivex-button--primary" onClick={() => action(voice.connect)} disabled={connected || voice.status === "connecting"}>{voice.status === "connecting" ? "Connecting…" : "Connect voice"}</button>
        <button className="zhivex-button zhivex-button--secondary" disabled={!connected} aria-pressed={voice.microphoneActive} onClick={() => voice.microphoneActive ? voice.stopMicrophone() : action(voice.startMicrophone)}>{voice.microphoneActive ? "Stop microphone" : "Start microphone"}</button>
        <button className="zhivex-button zhivex-button--secondary" disabled={!connected} onClick={() => action(voice.interrupt)}>Interrupt voice</button>
        <button className="zhivex-button zhivex-button--secondary" onClick={() => action(voice.disconnect)} disabled={voice.status === "disconnected"}>Disconnect voice</button>
      </div>
      <form className="omni-voice__text" onSubmit={event => { event.preventDefault(); if (!voiceText.trim() || sending) return; const text = voiceText; setSending(true); action(async () => { try { await voice.sendText(text); setVoiceText(current => current === text ? "" : current); } finally { setSending(false); } }); }}>
        <label htmlFor="voice-text">Prefer typing? Send a message to the voice session.</label>
        <div><input id="voice-text" value={voiceText} onChange={event => setVoiceText(event.target.value)} disabled={!connected} placeholder="Type something to hear a response…" /><button className="zhivex-button zhivex-button--primary" disabled={!connected || sending || !voiceText.trim()}>Send to voice</button></div>
      </form>
      {voice.error || actionError ? <p role="alert">{actionError ?? voice.error?.message}</p> : null}
      <ol className="omni-transcripts" aria-label="Voice transcript" aria-live="polite" aria-relevant="additions text">{voice.transcripts.map(item => <li key={item.id} data-role={item.role}><strong>{item.role === "user" ? "You" : "Omni"}</strong><p>{item.text}</p></li>)}</ol>
      <small>Voice uses a separate Qwen Realtime model.</small>
    </div>
  </section>;
}
