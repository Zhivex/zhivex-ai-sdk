import { tool, type ToolExecutionContext } from "@zhivex-ai/core";
import { z } from "zod";

import { SandboxError } from "./errors.js";
import { isDockerSandboxSession, type DockerSandboxSession } from "./environment.js";

const sessionFrom = (context: ToolExecutionContext | undefined): DockerSandboxSession => {
  if (!isDockerSandboxSession(context?.executionEnvironment)) {
    throw new SandboxError("SESSION_REQUIRED", "Sandbox tools require an acquired Docker execution environment.");
  }
  return context.executionEnvironment;
};

const approval = {
  requiresApproval: true,
  approvalMode: "interrupt" as const,
  approvalVersion: "docker-sandbox-1"
};

/** Filesystem and shell tools that execute only inside the acquired Docker session. */
export const createDockerSandboxTools = () => ({
  sandbox_read_file: tool({
    name: "sandbox_read_file",
    description: "Read a UTF-8 file inside the sandbox workspace.",
    schema: z.object({ path: z.string().min(1) }),
    metadata: {
      advancedRegistry: {
        permissions: ["filesystem"],
        audit: { riskLevel: "low" }
      }
    },
    execute: async ({ path }, context) => {
      const bytes = await sessionFrom(context).readFile(path);
      return { path, encoding: "utf-8", text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
    }
  }),
  sandbox_write_file: tool({
    name: "sandbox_write_file",
    description: "Write a UTF-8 file inside the sandbox workspace.",
    schema: z.object({ path: z.string().min(1), contents: z.string() }),
    ...approval,
    metadata: {
      advancedRegistry: {
        permissions: ["filesystem", "write"],
        audit: { riskLevel: "high" }
      }
    },
    execute: async ({ path, contents }, context) => {
      await sessionFrom(context).writeFile(path, contents);
      return { path, bytes: new TextEncoder().encode(contents).byteLength };
    }
  }),
  sandbox_list: tool({
    name: "sandbox_list",
    description: "List one directory level inside the sandbox workspace.",
    schema: z.object({ path: z.string().min(1).optional() }),
    metadata: {
      advancedRegistry: {
        permissions: ["filesystem"],
        audit: { riskLevel: "low" }
      }
    },
    execute: async ({ path }, context) => ({
      path: path ?? ".",
      entries: await sessionFrom(context).list(path ?? ".")
    })
  }),
  sandbox_exec: tool({
    name: "sandbox_exec",
    description: "Run an argv command inside the sandbox. There is no host shell and no inherited process environment.",
    schema: z.object({
      argv: z.array(z.string().min(1)).min(1).max(64),
      timeoutMs: z.number().int().positive().optional()
    }),
    ...approval,
    metadata: {
      advancedRegistry: {
        permissions: ["shell", "code-execution"],
        audit: { riskLevel: "high" }
      }
    },
    execute: async ({ argv, timeoutMs }, context) => {
      const result = await sessionFrom(context).exec(argv, timeoutMs === undefined ? undefined : { timeoutMs });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        timedOut: result.timedOut
      };
    }
  })
});
