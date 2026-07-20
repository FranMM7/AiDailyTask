export interface McpSessionFailure {
  code: -32000;
  httpStatus: 400 | 404;
  message: string;
}

/**
 * Classify session lookup state before a request reaches the MCP SDK transport.
 * A missing id is a malformed stateful request (400), while a supplied id that
 * is no longer known is an expired session (404). Initialization is the sole
 * request allowed to omit the id.
 */
export function mcpSessionFailure(
  sessionId: string | undefined,
  sessionExists: boolean,
  isInitialize: boolean,
): McpSessionFailure | null {
  if (sessionId) {
    if (sessionExists) return null;
    return {
      code: -32000,
      httpStatus: 404,
      message: "MCP session not found — initialize a new session.",
    };
  }
  if (isInitialize) return null;
  return {
    code: -32000,
    httpStatus: 400,
    message: "Missing mcp-session-id — send an initialize request first.",
  };
}
