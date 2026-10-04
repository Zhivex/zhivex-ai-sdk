const built = await Bun.build({ entrypoints: [`${import.meta.dir}/client.tsx`], target: "browser" });
if (!built.success) throw new Error("Could not build the offline example.");
const javascript = await built.outputs[0]!.text();
const styles = Bun.file(`${import.meta.dir}/../../packages/react/styles.css`);
Bun.serve({ hostname: "127.0.0.1", port: 3111, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/app.js") return new Response(javascript, { headers: { "content-type": "text/javascript" } });
  if (path === "/styles.css") return new Response(styles);
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Offline external runtime</title><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/app.js"></script></html>', { headers: { "content-type": "text/html" } });
} });
console.log("Offline example: http://127.0.0.1:3111");
