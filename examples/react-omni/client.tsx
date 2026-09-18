import { createRoot } from "react-dom/client";
import { OmniChat, VoiceChat } from "./app.js";
createRoot(document.getElementById("root")!).render(<main className="omni-workspace"><OmniChat /><VoiceChat /></main>);
