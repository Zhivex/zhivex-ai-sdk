"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MessageList, type MessageListProps } from "./components.js";

export interface VirtualizedMessageListProps extends Omit<MessageListProps, "renderMessages" | "viewportRef"> {
  estimatedMessageHeight?: number;
  overscan?: number;
}

const useClientLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

/** Variable-height virtualization. Give the viewport a bounded height. */
export function VirtualizedMessageList({ estimatedMessageHeight = 160, overscan = 5, ...props }: VirtualizedMessageListProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(props.autoFollow !== false);
  const virtualizer = useVirtualizer({
    count: props.messages.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => Number.isFinite(estimatedMessageHeight) && estimatedMessageHeight > 0 ? estimatedMessageHeight : 160,
    overscan: Number.isSafeInteger(overscan) && overscan >= 0 ? overscan : 5,
    getItemKey: (index) => props.messages[index]!.id
  });
  useClientLayoutEffect(() => {
    const element = viewport.current;
    if (element && following.current && props.autoFollow !== false) element.scrollTop = element.scrollHeight;
  });
  return <MessageList {...props} style={{ ...props.style, scrollBehavior: "auto" }} viewportRef={viewport}
    onScroll={(event) => {
      props.onScroll?.(event);
      if (event.defaultPrevented) return;
      const node = event.currentTarget;
      following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= (props.autoFollowThreshold ?? 96);
    }}
    renderMessages={(renderMessage) => <div className="zhivex-virtual-messages" style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%", flexShrink: 0 }}>
      {virtualizer.getVirtualItems().map((item) => <div key={item.key} data-index={item.index}
        ref={virtualizer.measureElement}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", display: "flex", flexDirection: "column", paddingBottom: 16, boxSizing: "border-box", transform: `translateY(${item.start}px)` }}>
        {renderMessage(props.messages[item.index]!)}
      </div>)}
    </div>}
  />;
}
