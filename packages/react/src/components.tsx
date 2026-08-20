"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";
import type {
  AgentApprovalRequest,
  ContentPart,
  JsonValue,
  MessageRole,
} from "@zhivex-ai/core";
import type {
  ChangeEvent,
  ClipboardEvent,
  ComponentPropsWithoutRef,
  ComponentType,
  DragEvent,
  FormEvent,
  HTMLAttributeReferrerPolicy,
  HTMLAttributes,
  KeyboardEvent,
  ReactNode,
  UIEvent
} from "react";
import { approvalKey } from "./approval.js";
import type {
  ChatActivity,
  ChatInputPart,
  ChatMessage,
  ChatSendInput,
  ChatState,
  ChatStatus
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
        ...labels
      }
    : defaultChatLabels;

const useChatLabels = (labels?: Partial<ChatLabels>): ResolvedChatLabels =>
  useMemo(() => mergeLabels(labels), [labels]);

const joinClassNames = (...classNames: Array<string | undefined>): string =>
  classNames.filter(Boolean).join(" ");

const labelForRole = (role: MessageRole, labels: ChatLabels): string => {
  if (role === "assistant") return labels.assistant;
  if (role === "user") return labels.user;
  if (role === "system") return labels.system;
  return labels.tool;
};

const prettyJson = (value: JsonValue | undefined): string => {
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
    (first === 192 &&
      (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
};

const isPrivateIPv6 = (hostname: string) => {
  if (!hostname.includes(":")) {
    return false;
  }
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
    if (isPrivateIPv4(labels.slice(index, index + 4).join("."))) {
      return true;
    }
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

  if (url.username || url.password) {
    return undefined;
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    if (policy.allowRemote !== true || !policy.allowUrl) {
      return undefined;
    }
    if (
      policy.allowPrivateNetwork !== true &&
      isPrivateHostname(url.hostname)
    ) {
      return undefined;
    }
  } else if (url.protocol === "blob:") {
    if (policy.allowBlobUrls === false) {
      return undefined;
    }
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
    if (policy.allowDataUrls === false) {
      return undefined;
    }
  } else {
    return undefined;
  }

  if (policy.allowUrl && !policy.allowUrl(url, context)) {
    return undefined;
  }
  return url.href;
};

const stringMediaSource = (
  data: string,
  mediaType: string,
  kind: MediaSourceKind,
  policy: MediaUrlPolicy = {}
): string | undefined => {
  const context = { kind, mediaType };
  if (URL_SOURCE_PATTERN.test(data)) {
    return mediaUrl(data, context, policy);
  }

  const compact = data.replace(/\s/g, "");
  if (
    compact.length >= 32 &&
    compact.length % 4 === 0 &&
    BASE64_PATTERN.test(compact)
  ) {
    return mediaUrl(
      `data:${mediaType};base64,${compact}`,
      context,
      policy
    );
  }
  return undefined;
};

const isBusyStatus = (status: ChatStatus): boolean =>
  status === "submitting" || status === "streaming";

const EMPTY_APPROVALS: readonly AgentApprovalRequest[] = [];
const EMPTY_ACTIVITY: readonly ChatActivity[] = [];
const EMPTY_STARTER_PROMPTS: readonly string[] = [];
const DEFAULT_AUTO_FOLLOW_THRESHOLD = 96;

const completedAssistantText = (
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

const messageText = (message: ChatMessage): string =>
  message.parts
    .filter(
      (part): part is Extract<ContentPart, { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("");

const humanizeIdentifier = (value: string): string => {
  const normalized = value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0
    ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
    : value;
};

export type ChatTheme = "system" | "light" | "dark";
export type ChatDensity = "comfortable" | "compact";

export interface ChatRootProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  label?: string;
  theme?: ChatTheme;
  density?: ChatDensity;
}

export function ChatRoot({
  children,
  className,
  label = defaultChatLabels.chat,
  theme = "system",
  density = "comfortable",
  ...props
}: ChatRootProps) {
  return (
    <section
      {...props}
      aria-label={label}
      className={joinClassNames("zhivex-chat", className)}
      data-density={density}
      data-slot="chat-root"
      data-theme={theme}
    >
      {children}
    </section>
  );
}

type PartType = ContentPart["type"];
type PartOfType<TType extends PartType> = Extract<ContentPart, { type: TType }>;

export interface MessagePartRendererProps<
  TPart extends ContentPart = ContentPart
> {
  part: TPart;
  message: ChatMessage;
  partIndex: number;
  labels: ChatLabels;
  mediaUrlPolicy?: MediaUrlPolicy;
  getImageAlt?: (
    part: Extract<ContentPart, { type: "image" }>,
    message: ChatMessage
  ) => string;
}

export type MessagePartRenderer<TType extends PartType = PartType> =
  ComponentType<MessagePartRendererProps<PartOfType<TType>>>;

export type MessagePartRenderers = {
  [TType in PartType]?: MessagePartRenderer<TType>;
};

export interface ToolCallCardProps
  extends Omit<HTMLAttributes<HTMLDetailsElement>, "part"> {
  part: Extract<ContentPart, { type: "tool-call" }>;
  labels?: Partial<ChatLabels>;
}

export function ToolCallCard({
  part,
  labels: labelsOverride,
  className,
  ...props
}: ToolCallCardProps) {
  const labels = useChatLabels(labelsOverride);
  const { toolCall } = part;

  return (
    <details
      {...props}
      className={joinClassNames("zhivex-card zhivex-tool-card", className)}
      data-slot="tool-call"
    >
      <summary>
        <span className="zhivex-card__summary">
          <span>{labels.toolCall}</span>
          <strong title={toolCall.name}>{humanizeIdentifier(toolCall.name)}</strong>
        </span>
      </summary>
      <div className="zhivex-card__body">
        <span className="zhivex-card__label">{labels.toolInput}</span>
        <pre>{prettyJson(toolCall.input)}</pre>
      </div>
    </details>
  );
}

export interface ToolResultCardProps
  extends Omit<HTMLAttributes<HTMLDetailsElement>, "part"> {
  part: Extract<ContentPart, { type: "tool-result" }>;
  labels?: Partial<ChatLabels>;
}

export function ToolResultCard({
  part,
  labels: labelsOverride,
  className,
  ...props
}: ToolResultCardProps) {
  const labels = useChatLabels(labelsOverride);
  const { toolResult } = part;
  const title = toolResult.isError ? labels.toolError : labels.toolResult;

  return (
    <details
      {...props}
      className={joinClassNames(
        "zhivex-card zhivex-tool-card",
        toolResult.isError ? "zhivex-card--error" : undefined,
        className
      )}
      data-slot="tool-result"
    >
      <summary>
        <span className="zhivex-card__summary">
          <span>{title}</span>
          <strong title={toolResult.toolName}>
            {humanizeIdentifier(toolResult.toolName)}
          </strong>
        </span>
      </summary>
      <div className="zhivex-card__body">
        {toolResult.error ? (
          <p className="zhivex-card__error" role="alert">
            {toolResult.error.message}
          </p>
        ) : (
          <pre>{prettyJson(toolResult.output)}</pre>
        )}
      </div>
    </details>
  );
}

export interface ToolExecutionCardProps
  extends Omit<HTMLAttributes<HTMLDetailsElement>, "part"> {
  call: Extract<ContentPart, { type: "tool-call" }>;
  result?: Extract<ContentPart, { type: "tool-result" }>;
  labels?: Partial<ChatLabels>;
}

export function ToolExecutionCard({
  call,
  result,
  labels: labelsOverride,
  className,
  ...props
}: ToolExecutionCardProps) {
  const labels = useChatLabels(labelsOverride);
  const failed = result?.toolResult.isError === true;
  const status = failed
    ? labels.failed
    : result
      ? labels.completed
      : labels.working;

  return (
    <details
      {...props}
      className={joinClassNames(
        "zhivex-card zhivex-tool-card zhivex-tool-execution",
        failed ? "zhivex-card--error" : undefined,
        className
      )}
      data-slot="tool-execution"
    >
      <summary>
        <span className="zhivex-card__summary">
          <span>{status}</span>
          <strong title={call.toolCall.name}>
            {humanizeIdentifier(call.toolCall.name)}
          </strong>
        </span>
      </summary>
      <div className="zhivex-card__body">
        <span className="zhivex-card__label">{labels.toolInput}</span>
        <pre>{prettyJson(call.toolCall.input)}</pre>
        {result ? (
          <>
            <span className="zhivex-card__label">
              {failed ? labels.toolError : labels.toolResult}
            </span>
            {result.toolResult.error ? (
              <p className="zhivex-card__error" role="alert">
                {result.toolResult.error.message}
              </p>
            ) : (
              <pre>{prettyJson(result.toolResult.output)}</pre>
            )}
          </>
        ) : null}
      </div>
    </details>
  );
}

export interface ProviderDataDetailsProps
  extends Omit<HTMLAttributes<HTMLDetailsElement>, "part"> {
  part: Extract<ContentPart, { type: "provider-data" }>;
  labels?: Partial<ChatLabels>;
}

export function ProviderDataDetails({
  part,
  labels: labelsOverride,
  className,
  ...props
}: ProviderDataDetailsProps) {
  const labels = useChatLabels(labelsOverride);

  return (
    <details
      {...props}
      className={joinClassNames("zhivex-card zhivex-provider-data", className)}
      data-slot="provider-data"
    >
      <summary>
        <span className="zhivex-card__summary">
          <span>{labels.providerData}</span>
          <strong>{part.provider}</strong>
        </span>
      </summary>
      <div className="zhivex-card__body">
        <pre>{prettyJson(part.data)}</pre>
      </div>
    </details>
  );
}

interface AudioContentProps {
  part: Extract<ContentPart, { type: "audio" }>;
  labels: ChatLabels;
  mediaUrlPolicy?: MediaUrlPolicy;
}

function AudioContent({ part, labels, mediaUrlPolicy }: AudioContentProps) {
  const [binarySource, setBinarySource] = useState<string>();

  useEffect(() => {
    if (
      typeof part.data === "string" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      setBinarySource(undefined);
      return;
    }

    const buffer =
      part.data instanceof Uint8Array
        ? part.data.slice().buffer
        : part.data.slice(0);
    const source = URL.createObjectURL(
      new Blob([buffer], { type: part.mediaType })
    );
    setBinarySource(source);

    return () => URL.revokeObjectURL(source);
  }, [part.data, part.mediaType]);

  const stringSource =
    typeof part.data === "string"
      ? stringMediaSource(
          part.data,
          part.mediaType,
          "audio",
          mediaUrlPolicy
        )
      : undefined;
  const source = stringSource ?? binarySource;
  const referrerPolicy = mediaUrlPolicy?.referrerPolicy ?? "no-referrer";

  return (
    <figure className="zhivex-media zhivex-audio" data-slot="audio">
      {part.filename ? <figcaption>{part.filename}</figcaption> : null}
      {source ? (
        <audio
          controls
          preload="metadata"
          src={source}
          {...({ referrerPolicy } as Record<string, string>)}
        >
          {labels.audioUnavailable}
        </audio>
      ) : (
        <p className="zhivex-media__fallback">{labels.audioUnavailable}</p>
      )}
      {part.transcript ? (
        <p className="zhivex-audio__transcript">{part.transcript}</p>
      ) : null}
    </figure>
  );
}

function DefaultMessagePart({
  part,
  message,
  labels,
  mediaUrlPolicy,
  getImageAlt,
}: MessagePartRendererProps): ReactNode {
  if (part.type === "text") {
    return (
      <p className="zhivex-message__text" data-slot="message-text">
        {part.text}
      </p>
    );
  }

  if (part.type === "image") {
    const source = stringMediaSource(
      part.image,
      part.mediaType ?? "image/png",
      "image",
      mediaUrlPolicy
    );
    return (
      <figure className="zhivex-media zhivex-image" data-slot="image">
        {source ? (
          <img
            alt={getImageAlt?.(part, message) ?? labels.imageAlt}
            loading="lazy"
            referrerPolicy={mediaUrlPolicy?.referrerPolicy ?? "no-referrer"}
            src={source}
          />
        ) : (
          <figcaption className="zhivex-media__fallback">
            {labels.imageUnavailable}
          </figcaption>
        )}
      </figure>
    );
  }

  if (part.type === "audio") {
    return (
      <AudioContent
        labels={labels}
        mediaUrlPolicy={mediaUrlPolicy}
        part={part}
      />
    );
  }

  if (part.type === "file") {
    const source = stringMediaSource(
      part.data,
      part.mediaType,
      "file",
      mediaUrlPolicy
    );
    const protocol = source ? new URL(source).protocol : undefined;
    return (
      <div className="zhivex-file" data-slot="file">
        <span aria-hidden="true" className="zhivex-file__mark">
          {part.filename?.split(".").at(-1)?.slice(0, 4).toUpperCase() ??
            labels.file.slice(0, 4).toUpperCase()}
        </span>
        <span className="zhivex-file__details">
          <strong>{part.filename ?? labels.file}</strong>
          <small>{part.mediaType}</small>
        </span>
        {source ? (
          <a
            aria-label={`${labels.openFile}: ${part.filename ?? labels.file}`}
            download={
              protocol === "data:" || protocol === "blob:"
                ? part.filename ?? "download"
                : undefined
            }
            href={source}
            rel="noreferrer"
            referrerPolicy={mediaUrlPolicy?.referrerPolicy ?? "no-referrer"}
            target={
              protocol === "http:" || protocol === "https:"
                ? "_blank"
                : undefined
            }
          >
            {labels.openFile}
          </a>
        ) : null}
      </div>
    );
  }

  if (part.type === "tool-call") {
    return <ToolCallCard labels={labels} part={part} />;
  }

  if (part.type === "tool-result") {
    return <ToolResultCard labels={labels} part={part} />;
  }

  if (part.type === "provider-data") {
    return <ProviderDataDetails labels={labels} part={part} />;
  }

  return null;
}

export interface MessagePartProps {
  part: ContentPart;
  message: ChatMessage;
  partIndex: number;
  renderers?: MessagePartRenderers;
  labels?: Partial<ChatLabels>;
  mediaUrlPolicy?: MediaUrlPolicy;
  getImageAlt?: MessagePartRendererProps["getImageAlt"];
}

export function MessagePart({
  part,
  message,
  partIndex,
  renderers,
  labels: labelsOverride,
  mediaUrlPolicy,
  getImageAlt,
}: MessagePartProps) {
  const labels = useChatLabels(labelsOverride);
  const Renderer = renderers?.[part.type] as
    | ComponentType<MessagePartRendererProps>
    | undefined;

  if (Renderer) {
    return (
      <Renderer
        labels={labels}
        getImageAlt={getImageAlt}
        message={message}
        mediaUrlPolicy={mediaUrlPolicy}
        part={part}
        partIndex={partIndex}
      />
    );
  }

  return (
    <DefaultMessagePart
      labels={labels}
      getImageAlt={getImageAlt}
      message={message}
      mediaUrlPolicy={mediaUrlPolicy}
      part={part}
      partIndex={partIndex}
    />
  );
}

type MessageRenderEntry =
  | { type: "part"; part: ContentPart; partIndex: number }
  | {
      type: "tool-execution";
      call: Extract<ContentPart, { type: "tool-call" }>;
      result?: Extract<ContentPart, { type: "tool-result" }>;
      partIndex: number;
    };

const messageRenderEntries = (
  message: ChatMessage,
  renderers: MessagePartRenderers | undefined
): MessageRenderEntry[] => {
  if (renderers?.["tool-call"] || renderers?.["tool-result"]) {
    return message.parts.map((part, partIndex) => ({
      type: "part",
      part,
      partIndex
    }));
  }

  const consumedResults = new Set<number>();
  const resultsByCallId = new Map<
    string,
    {
      part: Extract<ContentPart, { type: "tool-result" }>;
      partIndex: number;
    }
  >();
  message.parts.forEach((part, partIndex) => {
    if (part.type === "tool-result") {
      resultsByCallId.set(part.toolResult.toolCallId, { part, partIndex });
    }
  });
  const entries: MessageRenderEntry[] = [];
  message.parts.forEach((part, partIndex) => {
    if (consumedResults.has(partIndex)) return;
    if (part.type !== "tool-call") {
      entries.push({ type: "part", part, partIndex });
      return;
    }

    const match = resultsByCallId.get(part.toolCall.id);
    const result = match && match.partIndex > partIndex ? match.part : undefined;
    if (result && match) consumedResults.add(match.partIndex);
    entries.push({
      type: "tool-execution",
      call: part,
      result,
      partIndex
    });
  });
  return entries;
};

const statusLabel = (
  status: ChatMessage["status"],
  labels: ResolvedChatLabels
): string | undefined => {
  if (status === "pending") return labels.messagePending;
  if (status === "streaming") return labels.messageStreaming;
  if (status === "stopped") return labels.messageStopped;
  if (status === "error") return labels.messageError;
  return undefined;
};

export interface MessageActionsProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onCopy"> {
  message: ChatMessage;
  labels?: Partial<ChatLabels>;
  onCopy?: (message: ChatMessage, text: string) => void | Promise<void>;
  onCopyError?: (error: unknown, message: ChatMessage) => void;
  onRetry?: (message: ChatMessage) => void | Promise<void>;
  showStatus?: boolean;
}

export function MessageActions({
  message,
  labels: labelsOverride,
  onCopy,
  onCopyError,
  onRetry,
  showStatus = true,
  className,
  ...props
}: MessageActionsProps) {
  const labels = useChatLabels(labelsOverride);
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const text = messageText(message);
  const status = statusLabel(message.status, labels);

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    []
  );

  const copy = async () => {
    try {
      if (onCopy) {
        await onCopy(message, text);
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("The Clipboard API is not available.");
      }
      setCopied(true);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setCopied(false), 2_000);
    } catch (error) {
      onCopyError?.(error, message);
    }
  };

  if (!status && text.length === 0 && !onRetry) return null;

  return (
    <div
      {...props}
      className={joinClassNames("zhivex-message__actions", className)}
      data-slot="message-actions"
    >
      {showStatus && status ? (
        <span className="zhivex-message__status" data-status={message.status}>
          {status}
        </span>
      ) : null}
      <span className="zhivex-message__action-buttons">
        {text.length > 0 ? (
          <button
            className="zhivex-message__action"
            onClick={() => void copy()}
            type="button"
          >
            {copied ? labels.copied : labels.copy}
          </button>
        ) : null}
        {onRetry ? (
          <button
            className="zhivex-message__action"
            onClick={() => void onRetry(message)}
            type="button"
          >
            {labels.retry}
          </button>
        ) : null}
      </span>
    </div>
  );
}

export interface MessageProps
  extends Omit<HTMLAttributes<HTMLElement>, "onCopy"> {
  message: ChatMessage;
  renderers?: MessagePartRenderers;
  labels?: Partial<ChatLabels>;
  mediaUrlPolicy?: MediaUrlPolicy;
  getImageAlt?: MessagePartRendererProps["getImageAlt"];
  showActions?: boolean;
  showStatus?: boolean;
  onCopy?: MessageActionsProps["onCopy"];
  onCopyError?: MessageActionsProps["onCopyError"];
  onRetry?: MessageActionsProps["onRetry"];
}

function MessageView({
  message,
  renderers,
  labels: labelsOverride,
  mediaUrlPolicy,
  getImageAlt,
  showActions = true,
  showStatus = true,
  onCopy,
  onCopyError,
  onRetry,
  className,
  ...props
}: MessageProps) {
  const labels = useChatLabels(labelsOverride);
  const roleLabel = labelForRole(message.role, labels);
  const visibleStatus = statusLabel(message.status, labels);
  const entries = useMemo(
    () => messageRenderEntries(message, renderers),
    [message, renderers]
  );

  return (
    <article
      {...props}
      aria-label={`${roleLabel} ${labels.message}`}
      className={joinClassNames("zhivex-message", className)}
      data-role={message.role}
      data-slot="message"
      data-status={message.status}
    >
      <header className="zhivex-message__role">{roleLabel}</header>
      <div className="zhivex-message__content">
        {entries.map((entry) =>
          entry.type === "tool-execution" ? (
            <ToolExecutionCard
              key={`tool-${entry.call.toolCall.id}`}
              call={entry.call}
              labels={labels}
              result={entry.result}
            />
          ) : (
            <MessagePart
              key={`${entry.part.type}-${entry.partIndex}`}
              getImageAlt={getImageAlt}
              labels={labels}
              message={message}
              mediaUrlPolicy={mediaUrlPolicy}
              part={entry.part}
              partIndex={entry.partIndex}
              renderers={renderers}
            />
          )
        )}
      </div>
      {showActions && message.role === "assistant" ? (
        <MessageActions
          labels={labels}
          message={message}
          onCopy={onCopy}
          onCopyError={onCopyError}
          onRetry={onRetry}
          showStatus={showStatus}
        />
      ) : showStatus && visibleStatus ? (
        <span className="zhivex-message__status" data-status={message.status}>
          {visibleStatus}
        </span>
      ) : null}
    </article>
  );
}

export const Message = memo(MessageView);

export interface ApprovalCardProps extends HTMLAttributes<HTMLElement> {
  approval: AgentApprovalRequest;
  onDecision?: (
    approval: AgentApprovalRequest,
    approved: boolean,
    reason?: string
  ) => void | Promise<void>;
  onDecisionError?: (
    error: unknown,
    approval: AgentApprovalRequest,
    approved: boolean
  ) => void;
  disabled?: boolean;
  decisionErrorLabel?: string;
  description?: ReactNode;
  reasonMode?: "never" | "reject" | "always";
  reasonRequired?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  humanizeName?: boolean;
  labels?: Partial<ChatLabels>;
}

export function ApprovalCard({
  approval,
  onDecision,
  onDecisionError,
  disabled = false,
  decisionErrorLabel,
  description,
  reasonMode = "reject",
  reasonRequired = false,
  reasonLabel,
  reasonPlaceholder,
  humanizeName = true,
  labels: labelsOverride,
  className,
  ...props
}: ApprovalCardProps) {
  const labels = useChatLabels(labelsOverride);
  const [resolving, setResolving] = useState<"approve" | "reject" | null>(null);
  const [decisionErrorFor, setDecisionErrorFor] = useState<string>();
  const [reason, setReason] = useState("");
  const [reasonValidationFor, setReasonValidationFor] = useState<string>();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const headingId = useId();
  const decisionErrorId = useId();
  const reasonId = useId();
  const reasonErrorId = useId();
  const currentApprovalKey = approvalKey(approval);
  const hasDecisionError = decisionErrorFor === currentApprovalKey;
  const hasReasonError = reasonValidationFor === currentApprovalKey;

  const decide = async (approved: boolean) => {
    if (!onDecision || disabled || resolving) return;
    const shouldIncludeReason = reasonMode === "always" || !approved;
    const normalizedReason = shouldIncludeReason ? reason.trim() : "";
    if (!approved && reasonRequired && normalizedReason.length === 0) {
      setReasonValidationFor(currentApprovalKey);
      reasonRef.current?.focus();
      return;
    }

    setDecisionErrorFor(undefined);
    setReasonValidationFor(undefined);
    setResolving(approved ? "approve" : "reject");
    try {
      await onDecision(
        approval,
        approved,
        normalizedReason.length > 0 ? normalizedReason : undefined
      );
    } catch (error) {
      setDecisionErrorFor(currentApprovalKey);
      onDecisionError?.(error, approval, approved);
    } finally {
      setResolving(null);
    }
  };

  return (
    <article
      {...props}
      aria-labelledby={headingId}
      aria-describedby={
        hasDecisionError
          ? decisionErrorId
          : hasReasonError
            ? reasonErrorId
            : undefined
      }
      className={joinClassNames("zhivex-card zhivex-approval", className)}
      data-slot="approval"
    >
      <div className="zhivex-approval__heading">
        <div>
          <span className="zhivex-card__label">{labels.approval}</span>
          <h3 id={headingId}>
            {humanizeName ? humanizeIdentifier(approval.name) : approval.name}
          </h3>
        </div>
        {approval.serverLabel ? (
          <span className="zhivex-approval__server">
            {approval.serverLabel}
          </span>
        ) : null}
      </div>
      <p>{description ?? labels.approvalDescription}</p>
      {approval.arguments ? (
        <details>
          <summary>{labels.arguments}</summary>
          <pre>{approval.arguments}</pre>
        </details>
      ) : null}
      {reasonMode !== "never" ? (
        <div className="zhivex-approval__reason">
          <label htmlFor={reasonId}>
            {reasonLabel ?? labels.approvalReason}
          </label>
          <textarea
            aria-describedby={hasReasonError ? reasonErrorId : undefined}
            disabled={disabled || resolving !== null}
            id={reasonId}
            onChange={(event) => {
              setReason(event.currentTarget.value);
              setReasonValidationFor(undefined);
            }}
            placeholder={reasonPlaceholder ?? labels.approvalReasonPlaceholder}
            ref={reasonRef}
            rows={2}
            value={reason}
          />
          {hasReasonError ? (
            <p
              className="zhivex-approval__validation"
              id={reasonErrorId}
              role="alert"
            >
              {labels.approvalReasonRequired}
            </p>
          ) : null}
        </div>
      ) : null}
      {hasDecisionError ? (
        <p
          className="zhivex-approval__error"
          id={decisionErrorId}
          role="alert"
        >
          {decisionErrorLabel ?? labels.approvalError}
        </p>
      ) : null}
      {onDecision ? (
        <div className="zhivex-approval__actions">
          <button
            className="zhivex-button zhivex-button--secondary"
            disabled={disabled || resolving !== null}
            onClick={() => void decide(false)}
            type="button"
          >
            {resolving === "reject"
              ? `${labels.confirmReject}…`
              : labels.confirmReject}
          </button>
          <button
            className="zhivex-button zhivex-button--primary"
            disabled={disabled || resolving !== null}
            onClick={() => void decide(true)}
            type="button"
          >
            {resolving === "approve"
              ? `${labels.confirmApprove}…`
              : labels.confirmApprove}
          </button>
        </div>
      ) : null}
    </article>
  );
}

export interface ChatEmptyStateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  starterPrompts?: readonly string[];
  onStarterPrompt?: (prompt: string) => void;
  labels?: Partial<ChatLabels>;
}

export function ChatEmptyState({
  title,
  description,
  starterPrompts = EMPTY_STARTER_PROMPTS,
  onStarterPrompt,
  labels: labelsOverride,
  className,
  ...props
}: ChatEmptyStateProps) {
  const labels = useChatLabels(labelsOverride);
  return (
    <div
      {...props}
      className={joinClassNames("zhivex-empty", className)}
      data-slot="empty-state"
    >
      <div className="zhivex-empty__content">
        <h2>{title ?? labels.empty}</h2>
        <p>{description ?? labels.emptyDescription}</p>
        {starterPrompts.length > 0 ? (
          <div className="zhivex-empty__prompts">
            {starterPrompts.map((prompt) => (
              <button
                className="zhivex-empty__prompt"
                key={prompt}
                onClick={() => onStarterPrompt?.(prompt)}
                type="button"
              >
                {prompt}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const activityEntryLabel = (
  entry: ChatActivity,
  labels: ResolvedChatLabels
): string => {
  if (entry.type === "run-start") {
    return `${labels.step} ${entry.currentStep} ${labels.of} ${entry.maxSteps}`;
  }
  if (entry.type === "step-start") {
    return `${labels.step} ${entry.stepIndex}`;
  }
  if (entry.type === "step-finish") {
    return `${labels.step} ${entry.step.index}: ${humanizeIdentifier(entry.step.status)}`;
  }
  if (entry.type === "approval-request") {
    return `${labels.approval}: ${humanizeIdentifier(entry.approval.name)}`;
  }
  if (entry.type === "approval-resolved") {
    return `${humanizeIdentifier(entry.approval.approve ? labels.approve : labels.reject)}`;
  }
  if (entry.type === "compaction") {
    return labels.contextCompacted;
  }
  if (entry.type === "run-finish") {
    return `${labels.run} ${humanizeIdentifier(entry.status)}`;
  }
  return `${labels.session} ${humanizeIdentifier(entry.status)}`;
};

export interface ActivityPanelProps
  extends Omit<HTMLAttributes<HTMLDetailsElement>, "children"> {
  activity: readonly ChatActivity[];
  status?: ChatStatus;
  labels?: Partial<ChatLabels>;
  maxVisibleEntries?: number;
  renderEntry?: (entry: ChatActivity, index: number) => ReactNode;
}

export function ActivityPanel({
  activity,
  status = "streaming",
  labels: labelsOverride,
  maxVisibleEntries = 8,
  renderEntry,
  className,
  ...props
}: ActivityPanelProps) {
  const labels = useChatLabels(labelsOverride);
  const normalizedLimit =
    Number.isSafeInteger(maxVisibleEntries) && maxVisibleEntries > 0
      ? maxVisibleEntries
      : 8;
  const visible = activity.slice(-normalizedLimit);
  let run: Extract<ChatActivity, { type: "run-start" }> | undefined;
  let step: Extract<ChatActivity, { type: "step-start" }> | undefined;
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const entry = activity[index];
    if (!entry) continue;
    if (!run && entry.type === "run-start") run = entry;
    if (!step && entry.type === "step-start") step = entry;
    if (run && step) break;
  }
  const busy = isBusyStatus(status);
  const summary = run
    ? `${labels.step} ${step?.stepIndex ?? run.currentStep} ${labels.of} ${run.maxSteps}`
    : labels.activity;

  return (
    <details
      {...props}
      className={joinClassNames("zhivex-activity-panel", className)}
      data-slot="activity-panel"
    >
      <summary>
        <span className="zhivex-activity-panel__summary" role="status">
          <span>{summary}</span>
          {busy ? (
            <span aria-label={labels.activity} className="zhivex-activity__dots">
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </span>
          ) : null}
        </span>
      </summary>
      <ol aria-label={labels.activityDetails}>
        {visible.map((entry, index) => (
          <li key={`${entry.type}-${activity.length - visible.length + index}`}>
            {renderEntry?.(entry, index) ?? activityEntryLabel(entry, labels)}
          </li>
        ))}
      </ol>
    </details>
  );
}

export interface MessageListProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  messages: readonly ChatMessage[];
  status?: ChatStatus;
  pendingApprovals?: readonly AgentApprovalRequest[];
  activity?: readonly ChatActivity[];
  onApproval?: (
    approval: AgentApprovalRequest,
    approved: boolean,
    reason?: string
  ) => void | Promise<void>;
  onApprovalError?: ApprovalCardProps["onDecisionError"];
  renderers?: MessagePartRenderers;
  emptyState?: ReactNode;
  labels?: Partial<ChatLabels>;
  mediaUrlPolicy?: MediaUrlPolicy;
  getImageAlt?: MessagePartRendererProps["getImageAlt"];
  autoFollow?: boolean;
  autoFollowThreshold?: number;
  jumpToLatestLabel?: string;
  starterPrompts?: readonly string[];
  onStarterPrompt?: (prompt: string) => void;
  showMessageActions?: boolean;
  showMessageStatus?: boolean;
  onCopyMessage?: MessageActionsProps["onCopy"];
  onCopyError?: MessageActionsProps["onCopyError"];
  onRetry?: MessageActionsProps["onRetry"];
  announceResponseText?: boolean;
  renderActivity?: (activity: readonly ChatActivity[]) => ReactNode;
  approvalCardProps?: Omit<
    ApprovalCardProps,
    "approval" | "disabled" | "labels" | "onDecision" | "onDecisionError"
  >;
}

export function MessageList({
  messages,
  status = "ready",
  pendingApprovals = EMPTY_APPROVALS,
  activity = EMPTY_ACTIVITY,
  onApproval,
  onApprovalError,
  renderers,
  emptyState,
  labels: labelsOverride,
  mediaUrlPolicy,
  getImageAlt,
  autoFollow = true,
  autoFollowThreshold = DEFAULT_AUTO_FOLLOW_THRESHOLD,
  jumpToLatestLabel,
  starterPrompts,
  onStarterPrompt,
  showMessageActions = true,
  showMessageStatus = true,
  onCopyMessage,
  onCopyError,
  onRetry,
  announceResponseText = false,
  renderActivity,
  approvalCardProps,
  className,
  onScroll,
  ...props
}: MessageListProps) {
  const labels = useChatLabels(labelsOverride);
  const listRef = useRef<HTMLDivElement>(null);
  const [isFollowing, setIsFollowing] = useState(true);
  const [completionAnnouncement, setCompletionAnnouncement] = useState<{
    key: string;
    text: string;
  }>();
  const isBusy = isBusyStatus(status);
  const isEmpty = messages.length === 0 && pendingApprovals.length === 0;
  const latestCompletedAssistant = useMemo(
    () => completedAssistantText(messages),
    [messages]
  );
  const latestAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") return messages[index]?.id;
    }
    return undefined;
  }, [messages]);
  const latestCompletionKey = latestCompletedAssistant
    ? `${latestCompletedAssistant.id}\0${latestCompletedAssistant.text}`
    : undefined;
  const previousBusyRef = useRef(isBusy);
  const previousCompletionKeyRef = useRef(latestCompletionKey);
  const normalizedThreshold = Number.isFinite(autoFollowThreshold)
    ? Math.max(0, autoFollowThreshold)
    : DEFAULT_AUTO_FOLLOW_THRESHOLD;

  const scrollToLatest = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    setIsFollowing(true);
    list.scrollTop = list.scrollHeight;
  }, []);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    onScroll?.(event);
    if (!autoFollow || event.defaultPrevented) return;
    const list = event.currentTarget;
    const distanceFromBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight;
    setIsFollowing(distanceFromBottom <= normalizedThreshold);
  };

  useEffect(() => {
    if (!autoFollow || !isFollowing) return;
    scrollToLatest();
  }, [
    autoFollow,
    isFollowing,
    messages,
    pendingApprovals,
    scrollToLatest,
    status
  ]);

  useEffect(() => {
    const wasBusy = previousBusyRef.current;
    previousBusyRef.current = isBusy;
    if (isBusy) return;
    if (
      wasBusy &&
      latestCompletedAssistant &&
      latestCompletionKey !== undefined &&
      latestCompletionKey !== previousCompletionKeyRef.current
    ) {
      setCompletionAnnouncement({
        key: latestCompletionKey,
        text: latestCompletedAssistant.text
      });
    }
    previousCompletionKeyRef.current = latestCompletionKey;
  }, [isBusy, latestCompletedAssistant, latestCompletionKey]);

  return (
    <>
      <div
        {...props}
        aria-busy={isBusy}
        aria-live={isBusy ? "off" : "polite"}
        aria-relevant="additions"
        className={joinClassNames("zhivex-message-list", className)}
        data-slot="message-list"
        onScroll={handleScroll}
        ref={listRef}
        role="log"
        tabIndex={0}
      >
      {autoFollow && !isFollowing ? (
        <button
          className="zhivex-button zhivex-button--secondary zhivex-jump-to-latest"
          onClick={scrollToLatest}
          type="button"
        >
          {jumpToLatestLabel ?? labels.jumpToLatest}
        </button>
      ) : null}
      {isEmpty ? (
        emptyState ?? (
          <ChatEmptyState
            labels={labels}
            onStarterPrompt={onStarterPrompt}
            starterPrompts={starterPrompts}
          />
        )
      ) : (
        <>
          {messages.map((message) => (
            <Message
              key={message.id}
              getImageAlt={getImageAlt}
              labels={labels}
              message={message}
              mediaUrlPolicy={mediaUrlPolicy}
              onCopy={onCopyMessage}
              onCopyError={onCopyError}
              onRetry={
                onRetry && message.id === latestAssistantId
                  ? onRetry
                  : undefined
              }
              renderers={renderers}
              showActions={showMessageActions}
              showStatus={showMessageStatus}
            />
          ))}
          {pendingApprovals.map((approval) => (
            <ApprovalCard
              key={approvalKey(approval)}
              {...approvalCardProps}
              approval={approval}
              disabled={isBusy}
              labels={labels}
              onDecision={onApproval}
              onDecisionError={onApprovalError}
            />
          ))}
        </>
      )}
      {activity.length > 0
        ? renderActivity?.(activity) ?? (
            <ActivityPanel activity={activity} labels={labels} status={status} />
          )
        : null}
      {isBusy && activity.length === 0 ? (
        <p
          aria-label={labels.activity}
          className="zhivex-activity"
          role="status"
        >
          <span className="zhivex-activity__dots">
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </span>
        </p>
      ) : null}
      </div>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="zhivex-sr-only"
        role="status"
      >
        {completionAnnouncement ? (
          <span key={completionAnnouncement.key}>
            {labels.responseComplete}
            {announceResponseText ? `: ${completionAnnouncement.text}` : ""}
          </span>
        ) : null}
      </p>
    </>
  );
}

const DEFAULT_MAX_ATTACHMENTS = 4;
const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface ComposerAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  part: ChatInputPart;
}

type AttachmentReadResult =
  | { attachment: ComposerAttachment; file: File }
  | { error: Error; file: File };

const attachmentId = () =>
  typeof globalThis.crypto?.randomUUID === "function"
    ? `attachment_${globalThis.crypto.randomUUID()}`
    : `attachment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("File read failed."));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("File read returned an unsupported result."));
    reader.readAsDataURL(file);
  });

const fileToAttachment = async (file: File): Promise<ComposerAttachment> => {
  const mediaType = file.type || "application/octet-stream";
  const data = await readFileAsDataUrl(file);
  const part: ChatInputPart = mediaType.startsWith("image/")
    ? { type: "image", image: data, mediaType }
    : mediaType.startsWith("audio/")
      ? { type: "audio", data, mediaType, filename: file.name }
      : { type: "file", data, mediaType, filename: file.name };
  return {
    id: attachmentId(),
    name: file.name,
    mediaType,
    size: file.size,
    part
  };
};

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export interface ComposerProps
  extends Omit<
    ComponentPropsWithoutRef<"form">,
    "onSubmit" | "onDrop" | "onDragOver"
  > {
  value: string;
  onValueChange: (value: string) => void;
  onSend: (value: string) => void | Promise<void>;
  onSendMessage?: (input: ChatSendInput) => void | Promise<void>;
  onSendError?: (error: unknown) => void;
  onStop?: () => void;
  status?: ChatStatus;
  labels?: Partial<ChatLabels>;
  allowAttachments?: boolean;
  accept?: string;
  maxAttachments?: number;
  maxAttachmentBytes?: number;
  onAttachmentError?: (error: Error, file?: File) => void;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  onDrop?: ComponentPropsWithoutRef<"form">["onDrop"];
  onDragOver?: ComponentPropsWithoutRef<"form">["onDragOver"];
  textareaProps?: Omit<
    ComponentPropsWithoutRef<"textarea">,
    "value" | "onChange"
  >;
}

export function Composer({
  value,
  onValueChange,
  onSend,
  onSendMessage,
  onSendError,
  onStop,
  status = "ready",
  labels: labelsOverride,
  allowAttachments = true,
  accept,
  maxAttachments = DEFAULT_MAX_ATTACHMENTS,
  maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
  onAttachmentError,
  leadingActions,
  trailingActions,
  onDrop,
  onDragOver,
  textareaProps,
  className,
  ...props
}: ComposerProps) {
  const labels = useChatLabels(labelsOverride);
  const generatedTextareaId = useId();
  const textareaId = textareaProps?.id ?? generatedTextareaId;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const isBusy = isBusyStatus(status);
  const attachmentsEnabled = allowAttachments && Boolean(onSendMessage);
  const normalizedMaxAttachments =
    Number.isSafeInteger(maxAttachments) && maxAttachments > 0
      ? maxAttachments
      : DEFAULT_MAX_ATTACHMENTS;
  const normalizedMaxAttachmentBytes =
    Number.isSafeInteger(maxAttachmentBytes) && maxAttachmentBytes > 0
      ? maxAttachmentBytes
      : DEFAULT_MAX_ATTACHMENT_BYTES;
  const canSend =
    (value.trim().length > 0 || attachments.length > 0) &&
    !isBusy &&
    !textareaProps?.disabled &&
    !textareaProps?.readOnly;

  const addFiles = async (files: readonly File[]) => {
    if (!attachmentsEnabled || files.length === 0) return;
    setAttachmentError(undefined);
    const remaining = normalizedMaxAttachments - attachments.length;
    if (remaining <= 0) {
      const error = new Error(labels.attachmentLimit);
      setAttachmentError(error.message);
      onAttachmentError?.(error);
      return;
    }
    const selected = files.slice(0, remaining);
    if (files.length > remaining) setAttachmentError(labels.attachmentLimit);
    const results = await Promise.all(
      selected.map(async (file): Promise<AttachmentReadResult> => {
        if (file.size > normalizedMaxAttachmentBytes) {
          const error = new Error(
            `${labels.attachmentTooLarge} ${file.name} (${formatFileSize(file.size)}).`
          );
          return { error, file };
        }
        try {
          return { attachment: await fileToAttachment(file), file };
        } catch (cause) {
          const error = new Error(labels.attachmentReadError, { cause });
          return { error, file };
        }
      })
    );
    const next: ComposerAttachment[] = [];
    for (const result of results) {
      if ("attachment" in result) {
        next.push(result.attachment);
      } else {
        setAttachmentError(result.error.message);
        onAttachmentError?.(result.error, result.file);
      }
    }
    if (next.length > 0) {
      setAttachments((current) => [
        ...current,
        ...next.slice(0, normalizedMaxAttachments - current.length)
      ]);
    }
  };

  const submit = async () => {
    if (!canSend) return;
    try {
      if (attachments.length > 0 && onSendMessage) {
        const parts: ChatInputPart[] = [
          ...attachments.map((attachment) => attachment.part),
          ...(value.trim().length > 0
            ? ([{ type: "text", text: value }] as const)
            : [])
        ];
        await onSendMessage(parts);
        setAttachments([]);
        setAttachmentError(undefined);
      } else {
        await onSend(value);
      }
    } catch (error) {
      onSendError?.(error);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    textareaProps?.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    textareaProps?.onPaste?.(event);
    if (event.defaultPrevented || !attachmentsEnabled) return;
    const files = [...event.clipboardData.files];
    if (files.length > 0) void addFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    onDrop?.(event);
    if (event.defaultPrevented || !attachmentsEnabled) return;
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  const handleDragOver = (event: DragEvent<HTMLFormElement>) => {
    onDragOver?.(event);
    if (!event.defaultPrevented && attachmentsEnabled) event.preventDefault();
  };

  return (
    <form
      {...props}
      className={joinClassNames("zhivex-composer", className)}
      data-slot="composer"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onSubmit={handleSubmit}
    >
      {attachments.length > 0 ? (
        <ul aria-label={labels.attachments} className="zhivex-composer__attachments">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <span>
                <strong>{attachment.name}</strong>
                <small>{formatFileSize(attachment.size)}</small>
              </span>
              <button
                aria-label={`${labels.removeAttachment}: ${attachment.name}`}
                onClick={() =>
                  setAttachments((current) =>
                    current.filter((candidate) => candidate.id !== attachment.id)
                  )
                }
                type="button"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {attachmentError ? (
        <p className="zhivex-composer__error" role="alert">
          {attachmentError}
        </p>
      ) : null}
      {leadingActions || attachmentsEnabled ? (
        <span className="zhivex-composer__leading-actions">
          {leadingActions}
          {attachmentsEnabled ? (
            <>
              <input
                accept={accept}
                className="zhivex-sr-only"
                multiple
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const files = [...(event.currentTarget.files ?? [])];
                  event.currentTarget.value = "";
                  void addFiles(files);
                }}
                ref={fileInputRef}
                type="file"
              />
              <button
                aria-label={labels.attachFiles}
                className="zhivex-composer__attach"
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                {labels.attachFiles}
              </button>
            </>
          ) : null}
        </span>
      ) : null}
      <label className="zhivex-sr-only" htmlFor={textareaId}>
        {labels.inputLabel}
      </label>
      <textarea
        {...textareaProps}
        aria-label={textareaProps?.["aria-label"] ?? labels.inputLabel}
        id={textareaId}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={textareaProps?.placeholder ?? labels.inputPlaceholder}
        rows={textareaProps?.rows ?? 1}
        value={value}
      />
      {trailingActions ? (
        <span className="zhivex-composer__trailing-actions">
          {trailingActions}
        </span>
      ) : null}
      {isBusy && onStop ? (
        <button
          className="zhivex-button zhivex-button--stop"
          onClick={onStop}
          type="button"
        >
          {labels.stop}
        </button>
      ) : (
        <button
          className="zhivex-button zhivex-button--primary"
          disabled={!canSend}
          type="submit"
        >
          {labels.send}
        </button>
      )}
    </form>
  );
}

export interface ChatController {
  state: ChatState;
  input: string;
  setInput: (value: string) => void;
  send: (input?: string) => Promise<void>;
  sendMessage?: (input: ChatSendInput) => Promise<void>;
  stop: () => void;
  reload: () => Promise<void>;
  canReload?: boolean;
  resolveApproval: (
    approvalRequestId: string,
    approve: boolean,
    reason?: string,
    provider?: string
  ) => Promise<void>;
}

export interface ZhivexChatProps
  extends Omit<ChatRootProps, "children" | "label"> {
  controller: ChatController;
  header?: ReactNode;
  emptyState?: ReactNode;
  renderers?: MessagePartRenderers;
  labels?: Partial<ChatLabels>;
  mediaUrlPolicy?: MediaUrlPolicy;
  getImageAlt?: MessagePartRendererProps["getImageAlt"];
  starterPrompts?: readonly string[];
  onStarterPrompt?: (prompt: string) => void;
  formatError?: (error: Error) => ReactNode;
  showErrorDetails?: boolean;
  messageListProps?: Omit<
    MessageListProps,
    | "messages"
    | "status"
    | "pendingApprovals"
    | "activity"
    | "onApproval"
    | "onApprovalError"
    | "renderers"
    | "emptyState"
    | "labels"
    | "mediaUrlPolicy"
    | "getImageAlt"
    | "starterPrompts"
    | "onStarterPrompt"
  >;
  onApproval?: (
    approval: AgentApprovalRequest,
    approved: boolean,
    reason?: string
  ) => void | Promise<void>;
  onApprovalError?: ApprovalCardProps["onDecisionError"];
  onRetry?: () => void | Promise<void>;
  composerProps?: Omit<
    ComposerProps,
    | "value"
    | "onValueChange"
    | "onSend"
    | "onSendMessage"
    | "onStop"
    | "status"
    | "labels"
  >;
}

export function ZhivexChat({
  controller,
  header,
  emptyState,
  renderers,
  labels: labelsOverride,
  mediaUrlPolicy,
  getImageAlt,
  starterPrompts,
  onStarterPrompt,
  formatError,
  showErrorDetails = false,
  messageListProps,
  onApproval,
  onApprovalError,
  onRetry,
  composerProps,
  className,
  ...props
}: ZhivexChatProps) {
  const labels = useChatLabels(labelsOverride);
  const error = controller.state.error;
  const handleApproval =
    onApproval ??
    ((
      approval: AgentApprovalRequest,
      approved: boolean,
      reason?: string
    ) =>
      controller.resolveApproval(
        approval.id,
        approved,
        reason,
        approval.provider
      ));
  const retry =
    onRetry ??
    (controller.canReload === true ? () => controller.reload() : undefined);
  const handleStarterPrompt =
    onStarterPrompt ?? ((prompt: string) => controller.setInput(prompt));

  return (
    <ChatRoot {...props} className={className} label={labels.chat}>
      {header ? (
        <header className="zhivex-chat__header" data-slot="chat-header">
          {header}
        </header>
      ) : null}
      <MessageList
        {...messageListProps}
        activity={controller.state.activity}
        emptyState={emptyState}
        getImageAlt={getImageAlt}
        labels={labels}
        messages={controller.state.messages}
        mediaUrlPolicy={mediaUrlPolicy}
        onApproval={handleApproval}
        onApprovalError={onApprovalError}
        onRetry={retry ? () => retry() : undefined}
        onStarterPrompt={handleStarterPrompt}
        pendingApprovals={controller.state.pendingApprovals}
        renderers={renderers}
        starterPrompts={starterPrompts}
        status={controller.state.status}
      />
      {error ? (
        <div className="zhivex-error" data-slot="error" role="alert">
          <span>{formatError?.(error) ?? labels.error}</span>
          {showErrorDetails ? (
            <details>
              <summary>{labels.errorDetails}</summary>
              <pre>{error.message}</pre>
            </details>
          ) : null}
          {retry ? (
            <button
              className="zhivex-button zhivex-button--secondary"
              onClick={() => void retry()}
              type="button"
            >
              {labels.retry}
            </button>
          ) : null}
        </div>
      ) : null}
      <Composer
        {...composerProps}
        labels={labels}
        onSend={(value) => controller.send(value)}
        onSendMessage={controller.sendMessage}
        onStop={controller.stop}
        onValueChange={controller.setInput}
        status={controller.state.status}
        value={controller.input}
      />
    </ChatRoot>
  );
}
