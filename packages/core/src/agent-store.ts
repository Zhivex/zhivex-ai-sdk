import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentMemoryContext, AgentMemoryStore, AgentRunState, AgentRunStore, ModelMessage } from "./types.js";

const cloneState = (state: AgentRunState): AgentRunState => JSON.parse(JSON.stringify(state)) as AgentRunState;
const cloneMessages = (messages: ModelMessage[]): ModelMessage[] =>
  JSON.parse(JSON.stringify(messages)) as ModelMessage[];

const defaultMemoryKey = (context: AgentMemoryContext) => context.agentId ?? context.runId;

const defaultMemoryMessages = (state: AgentRunState): ModelMessage[] => {
  const lastAssistantMessage = [...state.messages].reverse().find((message) => message.role === "assistant");
  return lastAssistantMessage ? [lastAssistantMessage] : [];
};

export const createInMemoryAgentRunStore = (): AgentRunStore => {
  const states = new Map<string, AgentRunState>();

  return {
    load(runId) {
      const state = states.get(runId);
      return state ? cloneState(state) : undefined;
    },
    save(state) {
      states.set(state.runId, cloneState(state));
    },
    delete(runId) {
      states.delete(runId);
    }
  };
};

export const createFileAgentRunStore = (options: {
  directory: string;
}): AgentRunStore => ({
  async load(runId) {
    try {
      const content = await fs.readFile(path.join(options.directory, `${runId}.json`), "utf8");
      return JSON.parse(content) as AgentRunState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
  async save(state) {
    await fs.mkdir(options.directory, { recursive: true });
    await fs.writeFile(path.join(options.directory, `${state.runId}.json`), JSON.stringify(state, null, 2), "utf8");
  },
  async delete(runId) {
    try {
      await fs.unlink(path.join(options.directory, `${runId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
});

export const createInMemoryAgentMemoryStore = (options: {
  key?: (context: AgentMemoryContext) => string;
  initialMessages?: Record<string, ModelMessage[]>;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
} = {}): AgentMemoryStore => {
  const keyFor = options.key ?? defaultMemoryKey;
  const selectMessages = options.selectMessages ?? defaultMemoryMessages;
  const memories = new Map(
    Object.entries(options.initialMessages ?? {}).map(([key, messages]) => [key, cloneMessages(messages)])
  );

  return {
    load(context) {
      return cloneMessages(memories.get(keyFor(context)) ?? []);
    },
    save(context) {
      memories.set(keyFor(context), cloneMessages(selectMessages(context.state)));
    }
  };
};

export const createFileAgentMemoryStore = (options: {
  directory: string;
  key?: (context: AgentMemoryContext) => string;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
}): AgentMemoryStore => {
  const keyFor = options.key ?? defaultMemoryKey;
  const selectMessages = options.selectMessages ?? defaultMemoryMessages;

  return {
    async load(context) {
      try {
        const file = await fs.readFile(path.join(options.directory, `${keyFor(context)}.json`), "utf8");
        return JSON.parse(file) as ModelMessage[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
    async save(context) {
      await fs.mkdir(options.directory, { recursive: true });
      await fs.writeFile(
        path.join(options.directory, `${keyFor(context)}.json`),
        JSON.stringify(selectMessages(context.state), null, 2),
        "utf8"
      );
    }
  };
};
