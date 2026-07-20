import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpSessionFailure } from "./sessionLookup";

describe("mcpSessionFailure", () => {
  it("allows initialization without a session id", () => {
    assert.equal(mcpSessionFailure(undefined, false, true), null);
  });

  it("returns 400 when a stateful request omits the session id", () => {
    assert.deepEqual(mcpSessionFailure(undefined, false, false), {
      code: -32000,
      httpStatus: 400,
      message: "Missing mcp-session-id — send an initialize request first.",
    });
    assert.equal(mcpSessionFailure("", false, false)?.httpStatus, 400);
  });

  it("returns 404 when a supplied session id is unknown", () => {
    assert.deepEqual(mcpSessionFailure("expired-session", false, false), {
      code: -32000,
      httpStatus: 404,
      message: "MCP session not found — initialize a new session.",
    });
  });

  it("does not accept initialize with a stale session id", () => {
    assert.equal(mcpSessionFailure("expired-session", false, true)?.httpStatus, 404);
  });

  it("allows requests whose session id resolves", () => {
    assert.equal(mcpSessionFailure("active-session", true, false), null);
  });
});
