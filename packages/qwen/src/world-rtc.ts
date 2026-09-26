import { ConfigurationError } from "@zhivex-ai/core/runtime";
import type { QwenWorldModelId } from "./worlds.js";
/** Structural bridge to @happy-oyster/js-sdk; the application owns its optional browser dependency. */
export interface QwenWorldRTCTravel { start(): Promise<unknown>; end(): Promise<unknown> }
export interface QwenWorldRTCEngine<TTravel extends QwenWorldRTCTravel> {
  updateToken(token: string): void;
  createTravel(config: { ticket: string; videoElement: HTMLVideoElement; maxExperienceTimeSec?: 60 | 90 | 120 }): TTravel;
}
export interface QwenWorldRTCConfig {
  APIHost: string; model: QwenWorldModelId; token: string;
  logLevel?: "none" | "debug" | "info" | "warn" | "error"; streamReadyTimeout?: number;
}
/** Configure the official engine using a temporary key; preserves its exact native Travel type. */
export function createQwenWorldRTC<TTravel extends QwenWorldRTCTravel>(
  createEngine: (config: QwenWorldRTCConfig) => QwenWorldRTCEngine<TTravel>, config: QwenWorldRTCConfig
): QwenWorldRTCEngine<TTravel> & { startTravel(input: { ticket: string; videoElement: HTMLVideoElement; maxExperienceTimeSec?: 60 | 90 | 120 }): Promise<TTravel> } {
  if (!config.token?.startsWith("st-")) throw new ConfigurationError("World RTC requires a temporary API key (st-); never expose a primary key in a browser.");
  if (!/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(config.APIHost)) throw new ConfigurationError("APIHost must be a bare host without scheme or path.");
  if (!["happyoyster-1.0-adventure", "happyoyster-1.0-directing", "happyoyster-1.0-acting"].includes(config.model)) throw new ConfigurationError("Invalid world RTC model.");
  const engine = createEngine({ ...config, logLevel: config.logLevel ?? "none" });
  return {
    updateToken(token) { if (!token.startsWith("st-")) throw new ConfigurationError("World RTC requires a temporary API key."); engine.updateToken(token); },
    createTravel(input) { return engine.createTravel(input); },
    async startTravel(input) {
      const travel = engine.createTravel(input);
      try { await travel.start(); return travel; }
      catch (error) {
        try { await travel.end(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "World RTC start and cleanup failed; verify the travel has ended."); }
        throw error;
      }
    }
  };
}
