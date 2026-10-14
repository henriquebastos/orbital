import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { PiSession, ToolRegistration } from "./registration.js";
import { presentError } from "./presentation.js";

type ShellExecOptions = { signal?: AbortSignal; timeout?: number; onData: (chunk: Buffer) => void };

// Remote user-shell contract: stream at most 48,000 bytes inline; if nothing streamed, show the
// returned stdout and stderr up to that budget; always append the full-output path; an ordinary
// nonzero exit returns to the shell UI; any other result kind is an error.
async function executeRemoteUserShell(session: PiSession, command: string, options: ShellExecOptions) {
  const workspace = await session.workspace({ signal: options.signal });
  let sent = 0;
  const maxInline = 48_000;
  const result = await workspace.exec({ command,
    timeoutMs: options.timeout === undefined ? undefined : options.timeout * 1000 }, {
    signal: options.signal,
    onOutput(chunk) {
      const bytes = Buffer.from(chunk);
      const remaining = maxInline - sent;
      if (remaining > 0) {
        const shown = bytes.subarray(0, remaining);
        options.onData(shown);
        sent += shown.length;
      }
    },
  });
  if (sent === 0 && (result.stdout || result.stderr)) {
    const shown = Buffer.from(result.stdout + result.stderr).subarray(0, maxInline);
    options.onData(shown);
  }
  options.onData(Buffer.from(`\nFull output: ${result.outputPath}\n`));
  if (result.kind !== "exited") throw new Error(`Remote command ${result.kind}. Full output: ${result.outputPath}`);
  // User-shell UI receives ordinary nonzero exits. The Bash tool raises them as errors.
  return { exitCode: result.exitCode ?? null };
}

// User-shell commands follow the session route. The route is selected when Pi requests the
// shell operations, and every command counts as tracked work.
export function registerUserShell(pi: ExtensionAPI, session: PiSession, registration: ToolRegistration): void {
  pi.on("user_bash", () => {
    let route;
    try { route = session.control().route; }
    catch (error) { throw presentError(error); }
    const local = route === "local" ? createLocalBashOperations() : undefined;
    return { operations: {
      exec: (command, hostCwd, options) => registration.trackCall(async () => {
        try {
          if (local) return await local.exec(command, hostCwd, options);
          return await executeRemoteUserShell(session, command, options);
        } catch (error) {
          throw presentError(error);
        }
      }),
    } };
  });
}
