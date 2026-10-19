import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { loadTraceView, type LoadTraceViewOptions } from "./read.js";
import { renderMissingRun, renderTraceList, renderTraceRun } from "./page.js";
import type { TraceView } from "./view.js";

export const TRACE_VIEWER_DEFAULT_HOST = "127.0.0.1";
export const TRACE_VIEWER_DEFAULT_PORT = 9473;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface StartTraceViewerOptions extends LoadTraceViewOptions {
  host?: string;
  port?: number;
}

export interface RunningTraceViewer {
  url: string;
  host: string;
  port: number;
  view: TraceView;
  close: () => Promise<void>;
}

/** Accept only loopback hosts. `localhost` is bound as 127.0.0.1. */
export const resolveLoopbackHost = (host: string | undefined): string => {
  const requested = host?.trim() || TRACE_VIEWER_DEFAULT_HOST;
  if (!LOOPBACK_HOSTS.has(requested)) {
    throw new Error(`Refusing to bind "${requested}". The trace viewer only listens on 127.0.0.1 or ::1.`);
  }
  return requested === "localhost" ? "127.0.0.1" : requested;
};

const formatUrl = (host: string, port: number): string =>
  `http://${host.includes(":") ? `[${host}]` : host}:${port}/`;

const sendHtml = (response: ServerResponse, status: number, html: string) => {
  const body = Buffer.from(html);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
};

const route = (view: TraceView, request: IncomingMessage, response: ServerResponse) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let html: string;
  let status = 200;
  if (url.pathname === "/") {
    html = renderTraceList(view);
  } else if (url.pathname === "/run") {
    const runId = url.searchParams.get("id") ?? "";
    const run = view.runs.find((entry) => entry.runId === runId);
    if (!run) {
      status = 404;
      html = renderMissingRun(view, runId);
    } else {
      html = renderTraceRun(view, run);
    }
  } else {
    status = 404;
    html = renderMissingRun(view, url.pathname);
  }
  if (request.method === "HEAD") {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'"
    });
    response.end();
    return;
  }
  sendHtml(response, status, html);
};

/** Load the given files and serve the viewer on a loopback address. */
export const startTraceViewer = async (options: StartTraceViewerOptions): Promise<RunningTraceViewer> => {
  const host = resolveLoopbackHost(options.host);
  const port = options.port ?? TRACE_VIEWER_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port "${String(options.port)}".`);
  }
  const view = await loadTraceView(options);
  const server = createServer((request, response) => {
    try {
      route(view, request, response);
    } catch {
      sendHtml(response, 500, renderTraceList({ runs: [], warnings: [{ path: "server", message: "Failed to render the page." }] }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The trace viewer did not receive a TCP port.");
  }
  return {
    url: formatUrl(address.address, address.port),
    host: address.address,
    port: address.port,
    view,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
};
