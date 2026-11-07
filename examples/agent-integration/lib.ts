#!/usr/bin/env node
// Shared helpers for the Corkboard agent-integration examples.
//
// The bearer credential is read from the environment only. It is never accepted
// as a command-line argument (argv is visible in the process table and can be
// captured in an agent's tool output), and every rendered error redacts it.
import { PollError, redactAndEscape } from "../../scripts/poll.ts";

export const API_KEY_ENV = "CORKBOARD_APIKEY";

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

export function requireApiKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[API_KEY_ENV]?.trim() ?? "";
  // Same rule as scripts/poll.ts: a bearer credential is one non-empty value
  // with no whitespace. Never include the rejected value in the error.
  if (value === "" || /\s/.test(value)) {
    throw new AgentConfigError(
      `${API_KEY_ENV} must be a single non-empty value without whitespace; ` +
        "export it from a 0600 file outside the repository",
    );
  }
  return value;
}

// Only known-safe messages are rendered, and the credential is always redacted.
// Callers must never pass a body, digest, or raw response text as the message.
export function safeErrorMessage(error: unknown, secret: string): string {
  if (error instanceof AgentConfigError || error instanceof PollError) {
    return redactAndEscape(error.message, secret);
  }
  return "unexpected failure";
}
