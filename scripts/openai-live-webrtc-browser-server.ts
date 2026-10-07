const build = await Bun.build({ entrypoints: ["packages/openai/browser/live-webrtc-fixture.ts"], target: "browser", outdir: ".cache/openai-live-webrtc" });
if (!build.success) throw new Error(build.logs.join("\n"));
const artifact = await build.outputs[0].text();
if (/node:|process\.env|Bearer /.test(artifact)) throw new Error("Browser bundle contains Node dependencies or server credential handling.");
Bun.serve({ hostname: "127.0.0.1", port: 4186, fetch(request) {
  if (new URL(request.url).pathname === "/fixture.js") return new Response(artifact, { headers: { "content-type": "text/javascript" } });
  return new Response('<!doctype html><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
} });
