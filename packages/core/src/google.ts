import { hostedTool } from "./messages.js";
import type { JsonValue } from "./types.js";

export const googleSearchTool = () =>
  hostedTool({
    name: "google_search",
    type: "googleSearch",
    config: {},
    toolClass: "web-search"
  });

export const googleMapsTool = (config: {
  latitude?: number;
  longitude?: number;
  enableWidget?: boolean;
} = {}) =>
  hostedTool({
    name: "google_maps",
    type: "googleMaps",
    config: JSON.parse(JSON.stringify(config)) as JsonValue,
    toolClass: "web-search"
  });

export const googleUrlContextTool = () =>
  hostedTool({
    name: "google_url_context",
    type: "urlContext",
    config: {},
    toolClass: "web-extraction"
  });

export const googleFileSearchTool = (storeNames: string[]) =>
  hostedTool({
    name: "google_file_search",
    type: "fileSearch",
    config: {
      fileSearchStoreNames: storeNames
    },
    toolClass: "file-search"
  });

export const googleCodeExecutionTool = () =>
  hostedTool({
    name: "google_code_execution",
    type: "codeExecution",
    config: {},
    toolClass: "code-execution"
  });

export const googleComputerUseTool = (config: Record<string, unknown> = {}) =>
  hostedTool({
    name: "google_computer_use",
    type: "computerUse",
    config: JSON.parse(JSON.stringify(config)) as JsonValue,
    toolClass: "computer-use"
  });
