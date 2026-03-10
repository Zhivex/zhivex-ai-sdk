import { ParseError, ProviderHTTPError } from "./errors.js";

const decoder = new TextDecoder();

export async function* streamSSE(
  response: Response
): AsyncGenerator<{ event?: string; data: string }, void, undefined> {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Streaming request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }

  if (!response.body) {
    throw new ParseError("Streaming response did not include a body.");
  }

  let buffer = "";
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      let event: string | undefined;
      const dataLines: string[] = [];

      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      const data = dataLines.join("\n");
      if (data.length) {
        yield { event, data };
      }
    }
  }
}
