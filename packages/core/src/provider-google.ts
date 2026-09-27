/** Compatibility bridge for existing Google hosted tools shared by Gemini and Vertex.
 * New provider-native helpers belong to the provider packages, not Core.
 */
export {
  googleCodeExecutionTool,
  googleComputerUseTool,
  googleFileSearchTool,
  googleMapsTool,
  googleSearchTool,
  googleUrlContextTool
} from "./google.js";
