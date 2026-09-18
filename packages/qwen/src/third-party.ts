import { ConfigurationError, UnsupportedFeatureError, isCallableToolDefinition,
  type ModelCapabilities, type ModelGenerateInput } from "@zhivex-ai/core/provider";
import type { QwenLanguageModelOptions } from "./index.js";

// QwenCloud contracts, not the upstream vendors' direct APIs. Exact IDs prevent
// unverified future models/supplier routes from inheriting these capabilities.
// Sources: docs.qwencloud.com/api-reference/chat/{openai-chat,openai-responses}
// and www.qwencloud.com/models/{deepseek-v4.1-flash,kimi-k3,glm-5.2}.
interface Profile {
  effort: "high-max" | "snapshot" | "v41" | "low-high-max" | "fixed";
  thinkingOnly?: boolean;
  budget?: boolean;
  vision?: boolean;
  json?: boolean;
  responses?: boolean;
  hosted?: boolean;
  completionTokens?: boolean;
  glm?: boolean;
}
const deepseek: Profile = { effort: "high-max", json: true, responses: true, hosted: true, completionTokens: true };
const glm53: Profile = { effort: "low-high-max", thinkingOnly: true, json: true, responses: true, glm: true };
const profiles: Record<string, Profile> = {
  "deepseek-v4-pro": deepseek,
  "deepseek-v4-flash": deepseek,
  "deepseek-v4-pro-0813": { ...deepseek, effort: "snapshot" },
  "deepseek-v4-flash-0731": { ...deepseek, effort: "snapshot", json: false },
  "deepseek-v4.1-flash": { ...deepseek, effort: "v41", vision: true },
  "glm-5.2": { effort: "high-max", budget: true, json: true, responses: true, hosted: true, glm: true },
  "glm-5.3": glm53,
  "ZHIPU/GLM-5.3": { ...glm53, responses: false },
  "kimi-k3": { effort: "low-high-max", vision: true, json: true, responses: true, hosted: true },
  "MiniMax-M2.5": { effort: "fixed", thinkingOnly: true, responses: false }
};
export const thirdPartyProfile = (id: string): Profile | undefined => Object.hasOwn(profiles, id) ? profiles[id] : undefined;

export const thirdPartyCapabilities = (id: string): ModelCapabilities | undefined => {
  const p = thirdPartyProfile(id);
  if (!p) return undefined;
  return {
    streaming: true, tools: true, toolChoice: true, parallelToolCalls: false,
    structuredOutput: !!p.json, jsonMode: !!p.json, vision: !!p.vision,
    files: false, audioInput: false, audioOutput: false, embeddings: false,
    reasoning: true, reasoningEfforts: p.effort === "fixed" ? [] :
      p.thinkingOnly ? ["minimal", "low", "medium", "high", "xhigh", "max"] :
      ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    webSearch: !!p.hosted,
    agentCapabilities: { supportTier: "tier-b", toolChoiceNone: true,
      approvalRequests: false, hostedWebSearch: !!p.hosted, hostedFileSearch: false,
      remoteMcp: false, computerUse: false, codeExecution: !!p.hosted,
      webExtraction: !!p.hosted, toolsets: false }
  };
};

export const validateThirdParty = (id: string, input: ModelGenerateInput, options: QwenLanguageModelOptions) => {
  const p = thirdPartyProfile(id);
  if (!p) return;
  const fail = (message: string): never => { throw new UnsupportedFeatureError(`QwenCloud ${id}: ${message}`); };
  const effort = input.reasoning?.effort ?? options.reasoning_effort;
  const budget = input.reasoning?.budgetTokens ?? options.thinking_budget;
  if (input.reasoning?.effort !== undefined && options.reasoning_effort !== undefined ||
      input.reasoning?.budgetTokens !== undefined && options.thinking_budget !== undefined) {
    throw new ConfigurationError(`QwenCloud ${id}: configure reasoning through shared options or providerOptions, not both.`);
  }
  if (effort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) fail("unsupported reasoning effort.");
  if (p.thinkingOnly && (effort === "none" || options.enable_thinking === false)) fail("thinking cannot be disabled.");
  if (p.effort === "fixed" && (effort !== undefined || options.enable_thinking !== undefined)) fail("reasoning controls are not supported; use the model default.");
  if (budget !== undefined && !p.budget) fail("thinking budgets are not supported.");
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) throw new ConfigurationError(`QwenCloud ${id}: thinking budget must be a non-negative safe integer.`);
  if (budget !== undefined && effort !== undefined) throw new ConfigurationError(`QwenCloud ${id}: effort and budget cannot be combined.`);
  if (options.enable_thinking === false && (effort !== undefined && effort !== "none" || budget !== undefined) ||
      options.enable_thinking === true && effort === "none") throw new ConfigurationError(`QwenCloud ${id}: conflicting thinking controls.`);
  if (options.preserve_thinking !== undefined) fail("preserve_thinking is not supported for this model; reasoning history is sent in assistant messages.");
  if (options.clear_thinking !== undefined && (!p.glm || typeof options.clear_thinking !== "boolean")) fail("clear_thinking requires a GLM model and a boolean.");
  if (options.parallel_tool_calls === true) fail("parallel_tool_calls is not verified for this model.");
  if (options.tool_stream === true) fail("tool_stream is not supported for this model; ordinary streaming tool calls remain available.");
  if (input.structuredOutput?.mode === "native" && !p.json) fail("native structured output is not supported; use prompted mode.");
  if (id === "glm-5.2" && input.structuredOutput?.mode === "native" && effort !== "none" && options.enable_thinking !== false) fail("native JSON requires thinking disabled; set reasoning.effort to none or use prompted mode.");
  const format = options.response_format as { type?: string } | undefined;
  if (format && format.type !== "text") fail("use the shared structuredOutput option for JSON output.");
  for (const message of input.messages) for (const part of message.parts) {
    if (part.type === "image" && !p.vision) fail("image input is not supported.");
    if (part.type === "audio" || part.type === "file") fail("audio and file input are not supported.");
  }
  for (const tool of Object.values(input.tools ?? {})) {
    if (isCallableToolDefinition(tool)) continue;
    if (!p.hosted || !["web_search", "code_interpreter", "web_extractor"].includes(tool.type) ||
        tool.provider !== undefined && tool.provider !== "qwen" ||
        tool.config && typeof tool.config === "object" && "type" in tool.config && tool.config.type !== tool.type) {
      fail(`hosted tool ${tool.type} is not supported.`);
    }
  }
  if (!p.responses && (options.apiMode === "responses" || options.conversation !== undefined || options.instructions !== undefined)) fail("use Chat Completions for this model.");
};

export const thirdPartyReasoning = (id: string, input: ModelGenerateInput, options: QwenLanguageModelOptions, mode: "chat" | "responses") => {
  const p = thirdPartyProfile(id)!;
  const effort = input.reasoning?.effort ?? options.reasoning_effort;
  const disabled = effort === "none" || options.enable_thinking === false;
  let mapped = effort;
  if (effort && effort !== "none") {
    if (p.effort === "high-max") mapped = effort === "max" || effort === "xhigh" ? "max" : "high";
    else if (effort === "minimal") mapped = "low";
    else if (effort === "medium") mapped = "high";
    else if (effort === "xhigh") mapped = p.effort === "v41" || p.effort === "snapshot" && mode === "chat" ? "high" : "max";
  }
  if (mode === "responses") {
    const responseEffort = disabled ? "none" : mapped ?? (options.enable_thinking === true ? (p.effort === "low-high-max" ? "max" : "high") : undefined);
    return responseEffort ? { reasoning: { effort: responseEffort } } : {};
  }
  return {
    ...(disabled ? { enable_thinking: false } : mapped || options.enable_thinking === true ? { enable_thinking: true } : {}),
    ...(!disabled && mapped ? { reasoning_effort: mapped } : {}),
    ...((input.reasoning?.budgetTokens ?? options.thinking_budget) !== undefined ? { thinking_budget: input.reasoning?.budgetTokens ?? options.thinking_budget } : {}),
    ...(p.glm ? { clear_thinking: options.clear_thinking ?? false } : {})
  };
};
