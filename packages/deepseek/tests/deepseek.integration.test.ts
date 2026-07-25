import { describe, expect, it } from "vitest";
import { z } from "zod";

import { generateText, streamText, tool } from "@zhivex-ai/core";
import { createDeepSeek } from "../src/index.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
const extended = process.env.DEEPSEEK_EXTENDED_INTEGRATION === "1";
const baseURL = process.env.DEEPSEEK_BASE_URL;
const betaBaseURL = process.env.DEEPSEEK_BETA_BASE_URL;

const describeIntegration = apiKey && extended ? (describe.sequential ?? describe.skip) : describe.skip;

describeIntegration("deepseek extended integration", () => {
  const provider = () => createDeepSeek({ apiKey, baseURL, betaBaseURL });

  it("lists the live DeepSeek model catalog", async () => {
    const result = await provider().models.list();

    expect(result.models.some((model) => model.id === "deepseek-v4-pro")).toBe(true);
  });

  it("reads the live account balance", async () => {
    const result = await provider().balance.get();

    expect(typeof result.isAvailable).toBe("boolean");
    expect(result.balances.length).toBeGreaterThan(0);
  });

  it("generates and streams live FIM completions through beta", async () => {
    const deepseek = provider();
    const generated = await deepseek.fim.generate({
      model: "deepseek-v4-flash",
      prompt: "const deepSeekIntegration = ",
      suffix: ";\n",
      logprobs: 2,
      maxTokens: 32
    });

    expect(generated.text.length).toBeGreaterThan(0);
    expect(generated.finishReason).toBeDefined();
    expect(generated.choices[0]?.logprobs?.tokens?.length).toBeGreaterThan(0);

    const chunks: string[] = [];
    let finishSeen = false;
    let streamLogprobsSeen = false;
    for await (const event of await deepseek.fim.stream({
      model: "deepseek-v4-pro",
      prompt: "const deepSeekStreamingIntegration = ",
      suffix: ";\n",
      logprobs: 2,
      maxTokens: 32
    })) {
      if (event.type === "text-delta") {
        chunks.push(event.textDelta);
        streamLogprobsSeen ||= Boolean(event.logprobs?.tokens?.length);
      } else {
        finishSeen = true;
      }
    }

    expect(chunks.join("").length).toBeGreaterThan(0);
    expect(finishSeen).toBe(true);
    expect(streamLogprobsSeen).toBe(true);
  });

  it("continues a live assistant prefix through beta", async () => {
    const deepseek = provider();
    const result = await generateText({
      model: deepseek("deepseek-v4-pro"),
      prompt: "Complete the assistant prefix with a short valid sentence.",
      maxTokens: 32,
      providerOptions: {
        prefix: { content: "The verified result is" }
      }
    });

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.finishReason).toBeDefined();
  });

  it("runs a live strict tool call through beta in non-thinking mode", async () => {
    const deepseek = provider();
    const result = await generateText({
      model: deepseek("deepseek-v4-flash"),
      prompt: "Call the sum tool with a=2 and b=3.",
      reasoning: { effort: "none" },
      maxTokens: 64,
      maxSteps: 1,
      tools: {
        sum: tool({
          name: "sum",
          description: "Adds two integers and returns the total.",
          schema: z.object({
            a: z.number().int(),
            b: z.number().int()
          }),
          execute: ({ a, b }) => ({ total: a + b })
        })
      },
      toolChoice: {
        type: "tool",
        toolName: "sum"
      },
      providerOptions: {
        strictTools: true
      }
    });

    expect(result.toolResults[0]).toMatchObject({
      toolName: "sum",
      output: { total: 5 },
      isError: false
    });
  });

  it("runs a live strict tool call through beta in thinking mode", async () => {
    const deepseek = provider();
    const result = await generateText({
      model: deepseek("deepseek-v4-flash"),
      prompt: "You must call the sum tool with a=2 and b=3.",
      reasoning: { effort: "high" },
      maxTokens: 256,
      maxSteps: 1,
      tools: {
        sum: tool({
          name: "sum",
          description: "Adds two integers and returns the total.",
          schema: z.object({
            a: z.number().int(),
            b: z.number().int()
          }),
          execute: ({ a, b }) => ({ total: a + b })
        })
      },
      providerOptions: {
        strictTools: true
      }
    });

    expect(result.toolResults[0]).toMatchObject({
      toolName: "sum",
      output: { total: 5 },
      isError: false
    });
  });

  it("preserves live chat logprobs in streaming provider data", async () => {
    const deepseek = provider();
    const result = streamText({
      model: deepseek("deepseek-v4-flash"),
      prompt: "Reply with exactly: deepseek-logprobs-ok",
      reasoning: { effort: "none" },
      maxTokens: 32,
      providerOptions: {
        logprobs: true,
        top_logprobs: 2
      }
    });

    const providerEvents = [];
    for await (const event of result.eventStream) {
      if (event.type === "provider-data" && event.provider === "deepseek") {
        providerEvents.push(event);
      }
    }
    const final = await result.collect();

    expect(final.text.toLowerCase()).toContain("deepseek-logprobs-ok");
    expect(
      providerEvents.some(
        (event) =>
          typeof event.data === "object" &&
          event.data !== null &&
          !Array.isArray(event.data) &&
          event.data.type === "logprobs"
      )
    ).toBe(true);
  });
});
