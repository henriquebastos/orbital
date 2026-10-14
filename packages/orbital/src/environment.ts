import { OrbitalError } from "./operations.js";

export function validateEnvironment(value: unknown): asserts value is Record<string, string> | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.entries(value).some(([key, item]) => !key || key.includes("=") || key.includes("\0") ||
      typeof item !== "string" || item.includes("\0"))) {
    throw new OrbitalError("not_started", "invalid_environment",
      "Environment variables must be a string map with valid process environment names and values.");
  }
}
