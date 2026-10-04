import { createRoot } from "react-dom/client";
import { createOfflineHost, OfflineChat } from "./app.js";

const host = createOfflineHost();
createRoot(document.getElementById("root")!).render(<OfflineChat host={host} />);
