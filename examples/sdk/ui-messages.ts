import {
  createUIMessageJsonResponse,
  createUIMessageLinesResponse,
  fromUIMessages,
  parseUIMessageRequest,
  serializeUIMessage,
  toUIMessages,
  user
} from "@zhivex-ai/sdk";

const sourceMessages = [
  user("What changed in the SDK this week?")
];

const uiMessages = toUIMessages(sourceMessages);
console.log(uiMessages);
console.log(serializeUIMessage(uiMessages[0]!));

const modelMessages = fromUIMessages(uiMessages);
console.log(modelMessages);

const jsonRequest = new Request("https://example.test/chat", {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify(uiMessages)
});

const parsed = await parseUIMessageRequest(jsonRequest);
console.log(parsed);

const jsonResponse = createUIMessageJsonResponse(uiMessages);
const linesResponse = createUIMessageLinesResponse(uiMessages);

console.log(jsonResponse.headers.get("content-type"));
console.log(linesResponse.headers.get("content-type"));
