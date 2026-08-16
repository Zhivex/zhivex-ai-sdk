export const agentRealtimeCertificationProviders = ["gemini", "qwen", "openai"] as const;

export type AgentRealtimeCertificationProviderName =
  (typeof agentRealtimeCertificationProviders)[number];

export interface AgentRealtimeCertificationProviderConfig {
  name: AgentRealtimeCertificationProviderName;
  apiKey: string;
  modelId: string;
}

export interface AgentRealtimeCertificationConfig {
  enabled: boolean;
  timeoutMs: number;
  providers: AgentRealtimeCertificationProviderConfig[];
}

type CertificationEnvironment = Record<string, string | undefined>;

const requiredValue = (
  environment: CertificationEnvironment,
  names: string[],
  missing: string[]
) => {
  const value = names.map((name) => environment[name]?.trim()).find(Boolean);
  if (!value) {
    missing.push(names.join(" or "));
  }
  return value ?? "";
};

const certificationTimeout = (environment: CertificationEnvironment) => {
  const raw = environment.ZHIVEX_AGENT_REALTIME_TIMEOUT_MS?.trim();
  if (!raw) {
    return 45_000;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) {
    throw new Error(
      "ZHIVEX_AGENT_REALTIME_TIMEOUT_MS must be a safe integer between 1000 and 120000."
    );
  }
  return value;
};

const optionalModel = (
  environment: CertificationEnvironment,
  name: string,
  fallback: string
) => environment[name]?.trim() || fallback;

export const resolveAgentRealtimeCertificationConfig = (
  environment: CertificationEnvironment = process.env
): AgentRealtimeCertificationConfig => {
  if (environment.ZHIVEX_LIVE_AGENT_CERTIFICATION !== "1") {
    return {
      enabled: false,
      timeoutMs: 45_000,
      providers: []
    };
  }

  const missing: string[] = [];
  const geminiApiKey = requiredValue(
    environment,
    ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    missing
  );
  const geminiModelId = optionalModel(
    environment,
    "ZHIVEX_LIVE_AGENT_GEMINI_MODEL",
    "gemini-3.1-flash-live-preview"
  );
  const qwenApiKey = requiredValue(
    environment,
    ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
    missing
  );
  const qwenModelId = optionalModel(
    environment,
    "ZHIVEX_LIVE_AGENT_QWEN_MODEL",
    "qwen3.5-omni-plus-realtime"
  );
  const openAIApiKey = requiredValue(environment, ["OPENAI_API_KEY"], missing);
  const openAIModelId = optionalModel(
    environment,
    "ZHIVEX_LIVE_AGENT_OPENAI_MODEL",
    "gpt-realtime"
  );

  if (missing.length) {
    throw new Error(
      `Agent realtime certification requires explicit environment values for: ${missing.join(", ")}.`
    );
  }

  return {
    enabled: true,
    timeoutMs: certificationTimeout(environment),
    providers: [
      { name: "gemini", apiKey: geminiApiKey, modelId: geminiModelId },
      { name: "qwen", apiKey: qwenApiKey, modelId: qwenModelId },
      { name: "openai", apiKey: openAIApiKey, modelId: openAIModelId }
    ]
  };
};
