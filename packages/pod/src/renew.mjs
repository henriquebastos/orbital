import { Sandbox } from "e2b";

// Adapter for the E2B lease effect only. The runner owns scheduling, credential selection,
// and evidence sanitization. Rejections propagate unchanged.
export async function renew({ sandboxId, apiKey, windowMs, signal }) {
  await Sandbox.setTimeout(sandboxId, windowMs, { apiKey, requestTimeoutMs: 5000, signal });
}
