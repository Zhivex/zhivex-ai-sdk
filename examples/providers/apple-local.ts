import { generateText } from "@zhivex-ai/sdk";
import { createAppleLocal, createAppleLocalStdioTransport } from "@zhivex-ai/apple-local";

const bridge = process.env.APPLE_LOCAL_BRIDGE ?? "apple-local-bridge";
const apple = createAppleLocal({
  transport: createAppleLocalStdioTransport({ command: bridge })
});

const availability = await apple.availability();
console.log(availability);

const result = await generateText({
  model: apple("apple-on-device"),
  prompt: "Say hello from the on-device Apple Intelligence model."
});

console.log(result.text);
