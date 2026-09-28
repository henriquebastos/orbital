import { Sandbox } from "e2b";

export async function renew({ sandboxId, apiKey, windowMs, signal }) {
  await Sandbox.setTimeout(sandboxId, windowMs, { apiKey, requestTimeoutMs: 5000, signal });
}
