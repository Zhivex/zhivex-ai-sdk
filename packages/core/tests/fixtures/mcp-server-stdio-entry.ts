import { z } from "zod";

import { tool } from "../../src/index.js";
import { createMcpServer } from "../../src/mcp-server.js";
import { serveMcpStdio } from "../../src/mcp-server-stdio.js";

const server = createMcpServer({
  name: "official-stdio",
  version: "0.0.0-test",
  tools: {
    echo: tool({
      name: "echo",
      description: "Repeat text",
      schema: z.object({ text: z.string() }),
      execute: async ({ text }) => ({ text })
    })
  }
});

serveMcpStdio(server);
