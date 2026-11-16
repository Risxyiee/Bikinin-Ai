// Typed error that carries a protocol error code (see events.ts ErrorEvent).
import type { z } from "zod";
import type { ErrorEvent } from "./events.js";

export type ErrorCode = z.infer<typeof ErrorEvent>["code"];

export class AgentError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AgentError";
  }
}
