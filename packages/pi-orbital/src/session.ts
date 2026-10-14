import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { OrbitalError, type Observer, type Workspace } from "@henriquebastosnet/orbital";
import type { PiOptions, PiOrbitalApi } from "./extension.js";
import { restoreBinding, saveBinding, type Binding, type BindingState, type SessionControl } from "./binding.js";

// A session is fresh when it has no history of its own: a new session, or a startup
// session without a file, a parent, or entries beyond model and thinking-level changes.
function isFreshSessionForRouteDefault(ctx: ExtensionContext, reason: string): boolean {
  if (reason === "new") return true;
  const file = ctx.sessionManager.getSessionFile();
  return reason === "startup" && (!file || !existsSync(file))
    && !ctx.sessionManager.getHeader()?.parentSession
    && ctx.sessionManager.getEntries().every(entry => entry.type === "model_change" || entry.type === "thinking_level_change");
}

export function createPiSession(pi: ExtensionAPI, orbital: PiOrbitalApi,
  getOptions: () => Promise<PiOptions>) {
  let restoredControlState: BindingState = { kind: "unbound" };
  let orbId = "";
  let attachmentInFlight: Promise<Binding> | undefined;
  const initialControl = (route: "local" | "remote"): SessionControl => ({
    version: 1, route, allocation: "neverRequested", orbCwd: "/home/user",
  });
  // Invalid saved control fails closed even when a caller intends local dispatch.
  function control(): SessionControl {
    if (restoredControlState.kind === "invalid") throw new OrbitalError("not_started", "invalid_binding",
      "The saved Orbital binding is invalid. Attach explicitly to continue.");
    return restoredControlState.kind === "valid" ? restoredControlState.control : initialControl("local");
  }
  function persistControl(next: SessionControl): void {
    restoredControlState = { kind: "valid", control: saveBinding(pi, next) };
  }
  function binding(): Binding {
    const current = control();
    if (current.allocation !== "attached") throw new OrbitalError("not_started", "unbound", "No orb is attached.");
    return Object.freeze({ orbId, orbCwd: current.orbCwd });
  }
  // Creation inputs for a missing orb. Preparation may refresh settings, so reread options after it.
  async function resolveNewAllocationInputs() {
    let options = await getOptions();
    if (options.creationProblem) throw new OrbitalError("not_started", "configuration", options.creationProblem);
    const preparation = await options.preparation?.();
    if (options.preparation) {
      options = await getOptions();
      if (options.creationProblem) throw new OrbitalError("not_started", "configuration", options.creationProblem);
    }
    return { options, preparation };
  }
  // Coordinates one attachment: policy, inspection, creation when absent, then directory validation.
  // An explicit directory permits recovery of invalid or unresolved control, with reuse or creation.
  async function attachSessionOrb(signal?: AbortSignal, explicitDirectory?: string): Promise<Binding> {
    // 1. Implicit demand versus explicit recovery.
    const current = explicitDirectory !== undefined && restoredControlState.kind === "invalid" ? initialControl("remote") : control();
    if (explicitDirectory === undefined && current.allocation === "requested") {
      throw new OrbitalError("not_started", "allocation_unresolved",
        "The previous allocation request is unresolved. Inspect the orb and use create_and_attach explicitly to recover.");
    }
    if (explicitDirectory !== undefined && restoredControlState.kind !== "invalid" && current.route !== "remote") {
      // Persist explicit remote intent before lookup, even if attachment later fails.
      persistControl({ ...current, route: "remote" });
    }
    // 2. Inspect the session orb and reuse it when present.
    const id = orbId;
    const existing = await orbital.inspect({ orbId: id });
    if (!existing) {
      if (explicitDirectory === undefined && current.allocation !== "neverRequested") {
        throw new OrbitalError("not_started", "missing", "The previously requested orb is missing. Create it explicitly.");
      }
      // 3. Resolve creation inputs only for an absent orb.
      const { options, preparation } = await resolveNewAllocationInputs();
      // 4. Save requested before submission. Implicit demand cannot retry that state.
      persistControl({ ...current, route: "remote", allocation: "requested" });
      const orb = await orbital.create({ orbId: id, image: options.image, preparation, idleTimeoutMs: options.idleTimeoutMs,
        env: options.env }, { signal });
      if (orb.orbId !== id) throw new Error("Orbital returned an unexpected orb ID.");
    }
    // 5. Validate the selected directory, then save attached.
    const workspace = await orbital.openWorkspace({ orbId: id, orbCwd: "/home/user" }, { signal });
    const selected = await workspace.validateDirectory(explicitDirectory ?? current.orbCwd);
    persistControl({ ...current, route: "remote", allocation: "attached", orbCwd: selected });
    return Object.freeze({ orbId: id, orbCwd: selected });
  }
  // Acquire a remote workspace. Callers select the route before entering here.
  async function acquireRemoteWorkspace(observer: Observer = {}): Promise<Workspace> {
    const current = control();
    let target: Binding;
    if (current.allocation === "attached") target = binding();
    else {
      // Concurrent callers share the first caller's attachment signal until this attempt settles.
      attachmentInFlight ??= attachSessionOrb(observer.signal).finally(() => { attachmentInFlight = undefined; });
      target = await attachmentInFlight;
    }
    return orbital.openWorkspace(target, observer);
  }
  async function explicitlyAttachSessionOrb(orbCwd: string, signal?: AbortSignal): Promise<Binding> {
    if (attachmentInFlight) throw new OrbitalError("not_started", "busy", "Orbital activation is in progress.");
    attachmentInFlight = attachSessionOrb(signal, orbCwd).finally(() => { attachmentInFlight = undefined; });
    return attachmentInFlight;
  }
  return {
    get state() { return restoredControlState; },
    control,
    binding,
    async restore(ctx: ExtensionContext, reason: string) {
      orbId = ctx.sessionManager.getSessionId();
      // Restore discards any in-flight attachment so a branch or session change never adopts it.
      attachmentInFlight = undefined;
      restoredControlState = restoreBinding(ctx.sessionManager.getBranch());
      if (restoredControlState.kind !== "unbound") return;
      // autoOn seeds route intent for a fresh session. It does not attach anything.
      const shouldSeedRouteFromAutoOn = isFreshSessionForRouteDefault(ctx, reason);
      const options = shouldSeedRouteFromAutoOn ? await getOptions() : undefined;
      persistControl(initialControl(options?.autoOn ? "remote" : "local"));
    },
    setRoute(route: "local" | "remote") { persistControl({ ...control(), route }); },
    workspace: acquireRemoteWorkspace,
    create: explicitlyAttachSessionOrb,
    select(orbCwd: string) { persistControl({ ...control(), orbCwd }); return binding(); },
  };
}
