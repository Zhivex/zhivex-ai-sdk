import { handleDemoRequest } from "./routes.ts";

const built = await Bun.build({
  entrypoints: [`${import.meta.dir}/client.tsx`],
  target: "browser"
});
if (!built.success) throw new Error("Could not build the client approval example.");
const javascript = await built.outputs[0]!.text();

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Client approvals</title>
<div id="root"></div>
<script type="module" src="/app.js"></script>`;

Bun.serve({
  hostname: "127.0.0.1",
  port: 3112,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/app.js") {
      return new Response(javascript, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    const routed = await handleDemoRequest(request);
    if (routed) return routed;
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
});

console.log("Client approval example: http://127.0.0.1:3112");
