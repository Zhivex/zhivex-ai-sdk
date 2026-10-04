// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReviewCard, type ChatController } from "../src/components.js";
import { useExternalChat } from "../src/use-external-chat.js";
import { createInitialChatState } from "../src/reducer.js";
import { createOfflineHost, OfflineChat } from "../../../examples/react-external-runtime/app.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions = {
  input: "", setInput: vi.fn(), send: vi.fn(async () => {}), stop: vi.fn(),
  reload: vi.fn(async () => {}), resolveApproval: vi.fn(async () => {})
};

describe("external runtime presentation", () => {
  it("projects snapshots without storing a second ChatState and unsubscribes", async () => {
    let snapshot = { state: createInitialChatState(), revision: 1 };
    const listeners = new Set<() => void>();
    const store = { getSnapshot: () => snapshot, subscribe(listener: () => void) {
      listeners.add(listener); return () => { listeners.delete(listener); };
    } };
    const selectState = vi.fn((value: typeof snapshot) => value.state);
    let controller!: ChatController;
    const View = () => {
      const value = useExternalChat({ store, selectState, actions });
      controller = value.controller;
      return createElement("span", null, value.snapshot.revision);
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(createElement(View)));
    expect(controller.state).toBe(snapshot.state);
    expect(controller.send).toBe(actions.send);
    await act(async () => root.render(createElement(View)));
    expect(selectState).toHaveBeenCalledTimes(1);
    await act(async () => {
      snapshot = { state: { ...snapshot.state, sessionId: "next-session" }, revision: 2 };
      listeners.forEach((listener) => listener());
    });
    expect(container.textContent).toBe("2");
    expect(controller.state).toBe(snapshot.state);
    expect(controller.state.sessionId).toBe("next-session");
    expect(actions.send).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(listeners.size).toBe(0);
  });

  it("uses the host server snapshot during server rendering", () => {
    const View = () => {
      const { snapshot } = useExternalChat({ store: { subscribe: () => () => {},
        getSnapshot: () => "client", getServerSnapshot: () => "server" },
        selectState: () => createInitialChatState(), actions });
      return createElement("span", null, snapshot);
    };
    expect(renderToString(createElement(View))).toContain("server");
  });

  it("isolates pending opaque review callbacks across identities and reports errors", async () => {
    const opaqueToken = { token: Symbol("private") };
    let reject!: (error: Error) => void;
    const first = vi.fn((_token: unknown) => new Promise<void>((_, fail) => { reject = fail; }));
    const second = vi.fn(async () => {});
    const onDecisionError = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(createElement(ReviewCard, { reviewId: "session-a:review", heading: "First",
      reasonMode: "never", onDecision: () => first(opaqueToken), onDecisionError })));
    const approve = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve")!;
    await act(async () => { approve().click(); approve().click(); });
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(opaqueToken);
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
    await act(async () => root.render(createElement(ReviewCard, { reviewId: "session-b:review", heading: "Second",
      reasonMode: "never", onDecision: second })));
    expect(approve().disabled).toBe(false);
    await act(async () => { reject(new Error("Stale review")); });
    expect(onDecisionError).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { approve().click(); });
    expect(second).toHaveBeenCalledWith(true, undefined);
    await act(async () => root.unmount());
  });

  it("renders the offline host transcript, activity and reviews through existing components", async () => {
    const host = createOfflineHost();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(createElement(OfflineChat, { host })));
    await act(async () => host.send("Offline question"));
    expect(container.textContent).toContain("Offline question");
    expect(container.textContent).toContain("Host published a reply");
    expect(container.textContent).toContain("Accept the offline result");
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve")!.click();
    });
    expect(host.getSnapshot().review).toBeUndefined();
    expect(container.textContent).toContain("Host accepted review");
    await act(async () => root.unmount());
  });
});
