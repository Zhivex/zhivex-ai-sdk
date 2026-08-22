import { useMemo } from "react";
import type {
  AgentApprovalRequest,
  ContentPart,
  JsonValue,
  MessageRole,
} from "@zhivex-ai/core";
import type { HTMLAttributeReferrerPolicy } from "react";
import type {
  ChatActivity,
  ChatMessage,
  ChatStatus,
} from "./types.js";

export interface ChatLabels {
  chat: string;
  empty: string;
  assistant: string;
  user: string;
  system: string;
  tool: string;
  message: string;
  imageAlt: string;
  imageUnavailable: string;
  audioUnavailable: string;
  file: string;
  openFile: string;
  toolCall: string;
  toolInput: string;
  toolResult: string;
  toolError: string;
  providerData: string;
  approval: string;
  approvalDescription: string;
  approvalError: string;
  arguments: string;
  approve: string;
  reject: string;
  inputLabel: string;
  inputPlaceholder: string;
  send: string;
  stop: string;
  retry: string;
  activity: string;
  jumpToLatest: string;
  responseComplete: string;
  /** Optional extension labels retain compatibility with existing complete label maps. */
  emptyDescription?: string;
  attachFiles?: string;
  attachments?: string;
  removeAttachment?: string;
  attachmentLimit?: string;
  attachmentTooLarge?: string;
  attachmentReadError?: string;
  copy?: string;
  copied?: string;
  messagePending?: string;
  messageStreaming?: string;
  messageStopped?: string;
  messageError?: string;
  approvalReason?: string;
  approvalReasonPlaceholder?: string;
  approvalReasonRequired?: string;
  confirmApprove?: string;
  confirmReject?: string;
  activityDetails?: string;
  step?: string;
  of?: string;
  completed?: string;
  failed?: string;
  working?: string;
  error?: string;
  errorDetails?: string;
  contextCompacted?: string;
  run?: string;
  session?: string;
}

export type ResolvedChatLabels = Required<ChatLabels>;

export const defaultChatLabels: ResolvedChatLabels = {
  chat: "AI chat",
  empty: "Start a conversation.",
  assistant: "Assistant",
  user: "You",
  system: "System",
  tool: "Tool",
  message: "message",
  imageAlt: "Generated or attached content",
  imageUnavailable: "This image cannot be displayed.",
  audioUnavailable: "This audio cannot be played in the browser.",
  file: "File",
  openFile: "Open file",
  toolCall: "Tool call",
  toolInput: "Input",
  toolResult: "Tool result",
  toolError: "Tool error",
  providerData: "Provider data",
  approval: "Approval required",
  approvalDescription: "Review this action before allowing it to continue.",
  approvalError: "The decision could not be submitted. Try again.",
  arguments: "Arguments",
  approve: "Approve",
  reject: "Reject",
  inputLabel: "Message",
  inputPlaceholder: "Write a message…",
  send: "Send",
  stop: "Stop",
  retry: "Retry",
  activity: "The assistant is working",
  jumpToLatest: "Jump to latest message",
  responseComplete: "Assistant response",
  emptyDescription: "Ask a question or describe what you want to accomplish.",
  attachFiles: "Attach files",
  attachments: "Attachments",
  removeAttachment: "Remove attachment",
  attachmentLimit: "The attachment limit has been reached.",
  attachmentTooLarge: "This attachment is too large.",
  attachmentReadError: "This attachment could not be read.",
  copy: "Copy",
  copied: "Copied",
  messagePending: "Sending",
  messageStreaming: "Generating",
  messageStopped: "Stopped",
  messageError: "Failed",
  approvalReason: "Reason for rejecting (optional)",
  approvalReasonPlaceholder: "Explain why this action should not continue…",
  approvalReasonRequired: "Add a reason before rejecting this action.",
  confirmApprove: "Approve",
  confirmReject: "Reject",
  activityDetails: "Run activity",
  step: "Step",
  of: "of",
  completed: "Completed",
  failed: "Failed",
  working: "Working",
  error: "Something went wrong while generating the response.",
  errorDetails: "Technical details",
  contextCompacted: "Conversation context compacted",
  run: "Run",
  session: "Session",
};

const mergeLabels = (labels?: Partial<ChatLabels>): ResolvedChatLabels =>
  labels
    ? {
        ...defaultChatLabels,
        ...labels,
      }
    : defaultChatLabels;

export const useChatLabels = (
  labels?: Partial<ChatLabels>
): ResolvedChatLabels => useMemo(() => mergeLabels(labels), [labels]);

export const joinClassNames = (
  ...classNames: Array<string | undefined>
): string => classNames.filter(Boolean).join(" ");

export const labelForRole = (
  role: MessageRole,
  labels: ChatLabels
): string => {
  if (role === "assistant") return labels.assistant;
  if (role === "user") return labels.user;
  if (role === "system") return labels.system;
  return labels.tool;
};

export const prettyJson = (value: JsonValue | undefined): string => {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const URL_SOURCE_PATTERN = /^(?:https?:|blob:|data:)/i;
const BASE64_PATTERN = /^[a-z\d+/]+={0,2}$/i;

export type MediaSourceKind = "image" | "audio" | "file";

export interface MediaUrlContext {
  kind: MediaSourceKind;
  mediaType: string;
}

export interface MediaUrlPolicy {
  /** Allow public HTTP(S) media. Defaults to false. */
  allowRemote?: boolean;
  /** Allow loopback, link-local, private, and single-label hosts. Defaults to false. */
  allowPrivateNetwork?: boolean;
  /** Allow data URLs and raw base64 conversion. Defaults to true. */
  allowDataUrls?: boolean;
  /** Allow browser-managed blob URLs. Defaults to true. */
  allowBlobUrls?: boolean;
  /**
   * Required for remote HTTP(S) media. Restrict it to exact
   * application-controlled hosts; browser URL checks cannot pin DNS answers.
   */
  allowUrl?: (url: URL, context: MediaUrlContext) => boolean;
  /** Referrer policy for rendered links and media. Defaults to no-referrer. */
  referrerPolicy?: HTMLAttributeReferrerPolicy;
}

const normalizeHostname = (hostname: string) =>
  hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");

const isPrivateIPv4 = (hostname: string) => {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255
    )
  ) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
};

const isPrivateIPv6 = (hostname: string) => {
  if (!hostname.includes(":")) return false;
  if (
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("::ffff:")
  ) {
    return true;
  }
  const first = Number.parseInt(hostname.split(":")[0] ?? "", 16);
  return (
    (Number.isFinite(first) && (first & 0xfe00) === 0xfc00) ||
    (Number.isFinite(first) && (first & 0xffc0) === 0xfe80)
  );
};

const hasEmbeddedPrivateIPv4 = (hostname: string) => {
  const labels = hostname.split(".");
  for (let index = 0; index <= labels.length - 4; index += 1) {
    if (isPrivateIPv4(labels.slice(index, index + 4).join("."))) return true;
  }
  return false;
};

const isPrivateHostname = (hostname: string) => {
  const normalized = normalizeHostname(hostname);
  return (
    normalized.length === 0 ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "localtest.me" ||
    normalized.endsWith(".localtest.me") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".localdomain") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    (!normalized.includes(".") && !normalized.includes(":")) ||
    isPrivateIPv4(normalized) ||
    hasEmbeddedPrivateIPv4(normalized) ||
    isPrivateIPv6(normalized)
  );
};

const mediaUrl = (
  value: string,
  context: MediaUrlContext,
  policy: MediaUrlPolicy
): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.username || url.password) return undefined;

  if (url.protocol === "http:" || url.protocol === "https:") {
    if (policy.allowRemote !== true || !policy.allowUrl) return undefined;
    if (
      policy.allowPrivateNetwork !== true &&
      isPrivateHostname(url.hostname)
    ) {
      return undefined;
    }
  } else if (url.protocol === "blob:") {
    if (policy.allowBlobUrls === false) return undefined;
    try {
      const inner = new URL(url.pathname);
      if (
        (inner.protocol === "http:" || inner.protocol === "https:") &&
        policy.allowPrivateNetwork !== true &&
        isPrivateHostname(inner.hostname)
      ) {
        return undefined;
      }
    } catch {
      // Opaque browser-managed blob URLs are still governed by allowBlobUrls.
    }
  } else if (url.protocol === "data:") {
    if (policy.allowDataUrls === false) return undefined;
  } else {
    return undefined;
  }

  if (policy.allowUrl && !policy.allowUrl(url, context)) return undefined;
  return url.href;
};

export const stringMediaSource = (
  data: string,
  mediaType: string,
  kind: MediaSourceKind,
  policy: MediaUrlPolicy = {}
): string | undefined => {
  const context = { kind, mediaType };
  if (URL_SOURCE_PATTERN.test(data)) return mediaUrl(data, context, policy);

  const compact = data.replace(/\s/g, "");
  if (
    compact.length >= 32 &&
    compact.length % 4 === 0 &&
    BASE64_PATTERN.test(compact)
  ) {
    return mediaUrl(`data:${mediaType};base64,${compact}`, context, policy);
  }
  return undefined;
};

export const isBusyStatus = (status: ChatStatus): boolean =>
  status === "submitting" || status === "streaming";

export const EMPTY_APPROVALS: readonly AgentApprovalRequest[] = [];
export const EMPTY_ACTIVITY: readonly ChatActivity[] = [];
export const EMPTY_STARTER_PROMPTS: readonly string[] = [];
export const DEFAULT_AUTO_FOLLOW_THRESHOLD = 96;

export const completedAssistantText = (
  messages: readonly ChatMessage[]
): { id: string; text: string } | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.status !== "complete") {
      continue;
    }
    const text = message.parts
      .filter(
        (part): part is Extract<ContentPart, { type: "text" }> =>
          part.type === "text"
      )
      .map((part) => part.text)
      .join("");
    return text.length > 0 ? { id: message.id, text } : undefined;
  }
  return undefined;
};

export const messageText = (message: ChatMessage): string =>
  message.parts
    .filter(
      (part): part is Extract<ContentPart, { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("");

export const humanizeIdentifier = (value: string): string => {
  const normalized = value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0
    ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
    : value;
};
