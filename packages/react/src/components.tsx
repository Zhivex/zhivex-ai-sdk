"use client";

import { memo, useEffect, useId, useState } from "react";
import type {
  AgentApprovalRequest,
  ContentPart,
  JsonValue,
  MessageRole,
} from "@zhivex-ai/core";
import type {
  ComponentPropsWithoutRef,
  ComponentType,
  FormEvent,
  HTMLAttributeReferrerPolicy,
  HTMLAttributes,
  KeyboardEvent,
  ReactNode,
} from "react";
import { approvalKey } from "./approval.js";
import type { ChatMessage, ChatState, ChatStatus } from "./types.js";

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
  arguments: string;
  approve: string;
  reject: string;
  inputLabel: string;
  inputPlaceholder: string;
  send: string;
  stop: string;
  retry: string;
  activity: string;
}

export const defaultChatLabels: ChatLabels = {
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
  arguments: "Arguments",
  approve: "Approve",
  reject: "Reject",
  inputLabel: "Message",
  inputPlaceholder: "Write a message…",
  send: "Send",
  stop: "Stop",
  retry: "Retry",
  activity: "The assistant is working",
};

const mergeLabels = (labels?: Partial<ChatLabels>): ChatLabels => ({
  ...defaultChatLabels,
  ...labels,
});

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
  /** Additional application policy applied after the built-in network checks. */
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

const isPrivateHostname = (hostname: string) => {
  const normalized = normalizeHostname(hostname);
  return (
    normalized.length === 0 ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".localdomain") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    (!normalized.includes(".") && !normalized.includes(":")) ||
    isPrivateIPv4(normalized) ||
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
    if (policy.allowRemote !== true) {
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

export interface ChatRootProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  label?: string;
}

export function ChatRoot({
  children,
  className,
  label = defaultChatLabels.chat,
  ...props
}: ChatRootProps) {
  return (
    <section
      {...props}
      aria-label={label}
      className={joinClassNames("zhivex-chat", className)}
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
  const labels = mergeLabels(labelsOverride);
  const { toolCall } = part;

  return (
    <details
      {...props}
      className={joinClassNames("zhivex-card zhivex-tool-card", className)}
    >
      <summary>
        <span>{labels.toolCall}</span>
        <strong>{toolCall.name}</strong>
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
  const labels = mergeLabels(labelsOverride);
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
    >
      <summary>
        <span>{title}</span>
        <strong>{toolResult.toolName}</strong>
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
  const labels = mergeLabels(labelsOverride);

  return (
    <details
      {...props}
      className={joinClassNames("zhivex-card zhivex-provider-data", className)}
    >
      <summary>
        <span>{labels.providerData}</span>
        <strong>{part.provider}</strong>
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
    <figure className="zhivex-media zhivex-audio">
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
  labels,
  mediaUrlPolicy,
}: MessagePartRendererProps): ReactNode {
  if (part.type === "text") {
    return <p className="zhivex-message__text">{part.text}</p>;
  }

  if (part.type === "image") {
    const source = stringMediaSource(
      part.image,
      part.mediaType ?? "image/png",
      "image",
      mediaUrlPolicy
    );
    return (
      <figure className="zhivex-media zhivex-image">
        {source ? (
          <img
            alt={labels.imageAlt}
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
      <div className="zhivex-file">
        <span aria-hidden="true" className="zhivex-file__mark">
          ·
        </span>
        <span className="zhivex-file__details">
          <strong>{part.filename ?? labels.file}</strong>
          <small>{part.mediaType}</small>
        </span>
        {source ? (
          <a
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
}

export function MessagePart({
  part,
  message,
  partIndex,
  renderers,
  labels: labelsOverride,
  mediaUrlPolicy,
}: MessagePartProps) {
  const labels = mergeLabels(labelsOverride);
  const Renderer = renderers?.[part.type] as
    | ComponentType<MessagePartRendererProps>
    | undefined;

  if (Renderer) {
    return (
      <Renderer
        labels={labels}
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
      message={message}
      mediaUrlPolicy={mediaUrlPolicy}
      part={part}
      partIndex={partIndex}
    />
  );
}

export interface MessageProps extends HTMLAttributes<HTMLElement> {
  message: ChatMessage;
  renderers?: MessagePartRenderers;
  labels?: Partial<ChatLabels>;
  mediaUrlPolicy?: MediaUrlPolicy;
}

function MessageView({
  message,
  renderers,
  labels: labelsOverride,
  mediaUrlPolicy,
  className,
  ...props
}: MessageProps) {
  const labels = mergeLabels(labelsOverride);
  const roleLabel = labelForRole(message.role, labels);

  return (
    <article
      {...props}
      aria-label={`${roleLabel} ${labels.message}`}
      className={joinClassNames("zhivex-message", className)}
      data-role={message.role}
      data-status={message.status}
    >
      <header className="zhivex-message__role">{roleLabel}</header>
      <div className="zhivex-message__content">
        {message.parts.map((part, partIndex) => (
          <MessagePart
            key={`${part.type}-${partIndex}`}
            labels={labels}
            message={message}
            mediaUrlPolicy={mediaUrlPolicy}
            part={part}
            partIndex={partIndex}
            renderers={renderers}
          />
        ))}
      </div>
    </article>
  );
}

export const Message = memo(MessageView);

export interface ApprovalCardProps extends HTMLAttributes<HTMLElement> {
  approval: AgentApprovalRequest;
  onDecision?: (
    approval: AgentApprovalRequest,
    approved: boolean
  ) => void | Promise<void>;
  disabled?: boolean;
  labels?: Partial<ChatLabels>;
}

export function ApprovalCard({
  approval,
  onDecision,
  disabled = false,
  labels: labelsOverride,
  className,
  ...props
}: ApprovalCardProps) {
  const labels = mergeLabels(labelsOverride);
  const [resolving, setResolving] = useState<"approve" | "reject" | null>(null);
  const headingId = useId();

  const decide = (approved: boolean) => {
    if (!onDecision || disabled || resolving) return;

    setResolving(approved ? "approve" : "reject");
    void Promise.resolve(onDecision(approval, approved))
      .catch(() => undefined)
      .finally(() => setResolving(null));
  };

  return (
    <article
      {...props}
      aria-labelledby={headingId}
      className={joinClassNames("zhivex-card zhivex-approval", className)}
    >
      <div className="zhivex-approval__heading">
        <div>
          <span className="zhivex-card__label">{labels.approval}</span>
          <h3 id={headingId}>{approval.name}</h3>
        </div>
        {approval.serverLabel ? (
          <span className="zhivex-approval__server">
            {approval.serverLabel}
          </span>
        ) : null}
      </div>
      <p>{labels.approvalDescription}</p>
      {approval.arguments ? (
        <details>
          <summary>{labels.arguments}</summary>
          <pre>{approval.arguments}</pre>
        </details>
      ) : null}
      {onDecision ? (
        <div className="zhivex-approval__actions">
          <button
            className="zhivex-button zhivex-button--secondary"
            disabled={disabled || resolving !== null}
            onClick={() => decide(false)}
            type="button"
          >
            {resolving === "reject" ? `${labels.reject}…` : labels.reject}
          </button>
          <button
            className="zhivex-button zhivex-button--primary"
            disabled={disabled || resolving !== null}
            onClick={() => decide(true)}
            type="button"
          >
            {resolving === "approve" ? `${labels.approve}…` : labels.approve}
          </button>
        </div>
      ) : null}
    </article>
  );
}

export interface MessageListProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  messages: readonly ChatMessage[];
  status?: ChatStatus;
  pendingApprovals?: readonly AgentApprovalRequest[];
  onApproval?: (
    approval: AgentApprovalRequest,
    approved: boolean
  ) => void | Promise<void>;
  renderers?: MessagePartRenderers;
  emptyState?: ReactNode;
  labels?: Partial<ChatLabels>;
  mediaUrlPolicy?: MediaUrlPolicy;
}

export function MessageList({
  messages,
  status = "ready",
  pendingApprovals = [],
  onApproval,
  renderers,
  emptyState,
  labels: labelsOverride,
  mediaUrlPolicy,
  className,
  ...props
}: MessageListProps) {
  const labels = mergeLabels(labelsOverride);
  const isBusy = isBusyStatus(status);
  const isEmpty = messages.length === 0 && pendingApprovals.length === 0;

  return (
    <div
      {...props}
      aria-busy={isBusy}
      aria-live="polite"
      aria-relevant="additions text"
      className={joinClassNames("zhivex-message-list", className)}
      role="log"
      tabIndex={0}
    >
      {isEmpty ? (
        <div className="zhivex-empty">
          {emptyState ?? <p>{labels.empty}</p>}
        </div>
      ) : (
        <>
          {messages.map((message) => (
            <Message
              key={message.id}
              labels={labels}
              message={message}
              mediaUrlPolicy={mediaUrlPolicy}
              renderers={renderers}
            />
          ))}
          {pendingApprovals.map((approval) => (
            <ApprovalCard
              key={approvalKey(approval)}
              approval={approval}
              disabled={isBusy}
              labels={labels}
              onDecision={onApproval}
            />
          ))}
        </>
      )}
      {isBusy ? (
        <p
          aria-label={labels.activity}
          className="zhivex-activity"
          role="status"
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </p>
      ) : null}
    </div>
  );
}

export interface ComposerProps
  extends Omit<ComponentPropsWithoutRef<"form">, "onSubmit"> {
  value: string;
  onValueChange: (value: string) => void;
  onSend: (value: string) => void | Promise<void>;
  onStop?: () => void;
  status?: ChatStatus;
  labels?: Partial<ChatLabels>;
  textareaProps?: Omit<
    ComponentPropsWithoutRef<"textarea">,
    "value" | "onChange"
  >;
}

export function Composer({
  value,
  onValueChange,
  onSend,
  onStop,
  status = "ready",
  labels: labelsOverride,
  textareaProps,
  className,
  ...props
}: ComposerProps) {
  const labels = mergeLabels(labelsOverride);
  const generatedTextareaId = useId();
  const textareaId = textareaProps?.id ?? generatedTextareaId;
  const isBusy = isBusyStatus(status);
  const canSend =
    value.trim().length > 0 &&
    !isBusy &&
    !textareaProps?.disabled &&
    !textareaProps?.readOnly;

  const submit = () => {
    if (!canSend) return;
    void onSend(value);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
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
      submit();
    }
  };

  return (
    <form
      {...props}
      className={joinClassNames("zhivex-composer", className)}
      onSubmit={handleSubmit}
    >
      <label className="zhivex-sr-only" htmlFor={textareaId}>
        {labels.inputLabel}
      </label>
      <textarea
        {...textareaProps}
        aria-label={textareaProps?.["aria-label"] ?? labels.inputLabel}
        id={textareaId}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder={textareaProps?.placeholder ?? labels.inputPlaceholder}
        rows={textareaProps?.rows ?? 1}
        value={value}
      />
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
  stop: () => void;
  reload: () => Promise<void>;
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
  onApproval?: (
    approval: AgentApprovalRequest,
    approved: boolean
  ) => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
  composerProps?: Omit<
    ComposerProps,
    "value" | "onValueChange" | "onSend" | "onStop" | "status" | "labels"
  >;
}

const errorMessage = (error: unknown): string | undefined => {
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return undefined;
};

export function ZhivexChat({
  controller,
  header,
  emptyState,
  renderers,
  labels: labelsOverride,
  mediaUrlPolicy,
  onApproval,
  onRetry,
  composerProps,
  className,
  ...props
}: ZhivexChatProps) {
  const labels = mergeLabels(labelsOverride);
  const error = errorMessage(controller.state.error);
  const handleApproval =
    onApproval ??
    ((approval: AgentApprovalRequest, approved: boolean) =>
      controller.resolveApproval(
        approval.id,
        approved,
        undefined,
        approval.provider
      ));

  return (
    <ChatRoot {...props} className={className} label={labels.chat}>
      {header ? (
        <header className="zhivex-chat__header">{header}</header>
      ) : null}
      <MessageList
        emptyState={emptyState}
        labels={labels}
        messages={controller.state.messages}
        mediaUrlPolicy={mediaUrlPolicy}
        onApproval={handleApproval}
        pendingApprovals={controller.state.pendingApprovals}
        renderers={renderers}
        status={controller.state.status}
      />
      {error ? (
        <div className="zhivex-error" role="alert">
          <span>{error}</span>
          {onRetry ? (
            <button
              className="zhivex-button zhivex-button--secondary"
              onClick={() => void onRetry()}
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
        onStop={controller.stop}
        onValueChange={controller.setInput}
        status={controller.state.status}
        value={controller.input}
      />
    </ChatRoot>
  );
}
