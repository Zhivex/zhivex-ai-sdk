import { SandboxError } from "./errors.js";

const WORKSPACE_ROOT = "/workspace";

export const assertWorkspaceRoot = (root: string): string => {
  if (root !== WORKSPACE_ROOT) {
    throw new SandboxError(
      "WORKSPACE_ROOT",
      `Sandbox workspace root must be ${WORKSPACE_ROOT}.`
    );
  }
  return root;
};

/** Resolve a caller path and reject escapes outside the sandbox workspace. */
export const resolveWorkspacePath = (root: string, input: string): string => {
  assertWorkspaceRoot(root);
  if (typeof input !== "string" || input.length === 0 || input.length > 4096 || input.includes("\0")) {
    throw new SandboxError("PATH_INVALID", "Sandbox path must be a non-empty string without NUL bytes.");
  }
  const candidate = input.startsWith("/") ? input : `${root}/${input}`;
  const parts: string[] = [];
  for (const part of candidate.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new SandboxError("PATH_ESCAPE", "Sandbox path cannot contain '..'.");
    }
    parts.push(part);
  }
  const resolved = `/${parts.join("/")}`;
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new SandboxError("PATH_ESCAPE", "Sandbox path is outside the workspace.");
  }
  return resolved;
};

export const assertRelativeWorkspacePath = (input: string): string => {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096 || input.includes("\0")) {
    throw new SandboxError("PATH_INVALID", "Declared workspace path must be a non-empty relative string.");
  }
  if (input.startsWith("/") || input.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new SandboxError("PATH_ESCAPE", `Declared workspace path "${input}" must stay inside the workspace.`);
  }
  return input;
};

/** Allow argv0 as a bare name or an executable under /bin or /usr/bin. */
export const commandBaseName = (argv0: string): string => {
  if (argv0.length === 0 || argv0.includes("\0") || argv0.includes("..") || argv0.startsWith("-")) {
    throw new SandboxError("COMMAND_INVALID", "Sandbox command is not an allowlisted executable name.");
  }
  if (argv0.startsWith("/")) {
    const slash = argv0.lastIndexOf("/");
    const directory = argv0.slice(0, slash);
    if (directory !== "/bin" && directory !== "/usr/bin") {
      throw new SandboxError("COMMAND_INVALID", "Sandbox command must live in /bin or /usr/bin.");
    }
    return argv0.slice(slash + 1);
  }
  if (argv0.includes("/")) {
    throw new SandboxError("COMMAND_INVALID", "Sandbox command cannot be a relative path.");
  }
  return argv0;
};
