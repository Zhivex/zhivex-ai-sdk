import type { UIMessage } from "./types.js";
import { deserializeUIMessage, serializeUIMessage } from "./ui.js";

export const parseUIMessageRequest = async (request: Request): Promise<UIMessage[]> => {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = await request.json();
    return body as UIMessage[];
  }

  const text = await request.text();
  if (!text.trim()) {
    return [];
  }

  return text
    .trim()
    .split("\n")
    .map((line) => deserializeUIMessage(line));
};

export const createUIMessageJsonResponse = (messages: UIMessage[], init: ResponseInit = {}): Response =>
  Response.json(messages, init);

export const createUIMessageLinesResponse = (messages: UIMessage[], init: ResponseInit = {}): Response =>
  new Response(messages.map((message) => serializeUIMessage(message)).join("\n"), {
    ...init,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      ...Object.fromEntries(new Headers(init.headers).entries())
    }
  });
