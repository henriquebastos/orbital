import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { OrbitalError, type Observer, type Workspace } from "@henriquebastosnet/orbital";
import type { PiOptions, PiOrbitalApi } from "./extension.js";
import { restoreSessionControl, saveSessionControl, type AttachedOrb, type ControlState, type SessionControl } from "./control.js";
import { remoteHome as defaultRemoteDirectory } from "./presentation.js";

// A session is fresh when it has no history of its own: a new session, or a startup
// session without a file, a parent, or entries beyond model and thinking-level changes.
function isFreshSessionForRouteDefault(ctx: ExtensionContext, reason: string): boolean {
  if (reason === "new") return true;
  const file = ctx.sessionManager.getSessionFile();
  return reason === "startup" && (!file || !existsSync(file))
    && !ctx.sessionManager.getHeader()?.parentSession
    && ctx.sessionManager.getEntries().every(entry => entry.type === "model_change" || entry.type === "thinking_level_change");
}

// Session control for one Pi session: durable route and allocation knowledge, the attachment
// policy that turns remote demand into an attached orb, and the shared in-process activation.
export function createPiSession(pi: ExtensionAPI, orbital: PiOrbitalApi,
  getOptions: () => Promise<PiOptions>) {
  // 1. Durable control access and persistence.
  let controlState: ControlState = { kind: "unbound" };
  let orbId = "";
  let attachmentInFlight: Promise<AttachedOrb> | undefined;
  const initialControl = (route: "local" | "remote"): SessionControl => ({
    version: 1, route, allocation: "neverRequested", orbCwd: defaultRemoteDirectory,
  });
  // Invalid saved control fails closed even when a caller intends local dispatch.
  function control(): SessionControl {
    if (controlState.kind === "invalid") throw new OrbitalError("not_started", "invalid_control",
      "The saved Orbital session control is invalid. Attach explicitly to continue.");
    return controlState.kind === "valid" ? controlState.control : initialControl("local");
  }
  function persistControl(next: SessionControl): void {
    controlState = { kind: "valid", control: saveSessionControl(pi, next) };
  }
  function attachment(): AttachedOrb {
    const current = control();
    if (current.allocation !== "attached") throw new OrbitalError("not_started", "unbound", "No orb is attached.");
    return Object.freeze({ orbId, orbCwd: current.orbCwd });
  }
  // 2. Attachment policy and the ordered provider operations.
  //
  // | Control            | Implicit demand (workspace tools, user shell) | Explicit create_and_attach      |
  // | attached           | opens the attached orb directly               | inspect, reuse or recreate       |
  // | requested          | refused: the last allocation is unresolved    | inspect, reuse or recreate       |
  // | neverRequested     | inspect, reuse or create                      | inspect, reuse or create         |
  // | invalid            | refused on both routes                        | recovers from fresh remote control |
  // Deletion keeps attached control, so implicit demand never silently replaces a deleted orb.

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
  // Explicit attachment permits recovery of invalid or unresolved control, with reuse or creation.
  async function attachSessionOrb(signal: AbortSignal | undefined,
    demand: { explicit: false } | { explicit: true; directory?: string }): Promise<AttachedOrb> {
    // 1. Implicit demand versus explicit recovery.
    const current = demand.explicit && controlState.kind === "invalid" ? initialControl("remote") : control();
    if (!demand.explicit && current.allocation === "requested") {
      throw new OrbitalError("not_started", "allocation_unresolved",
        "The previous allocation request is unresolved. Inspect the orb and use create_and_attach explicitly to recover.");
    }
    if (demand.explicit && controlState.kind !== "invalid" && current.route !== "remote") {
      // Persist explicit remote intent before lookup, even if attachment later fails.
      persistControl({ ...current, route: "remote" });
    }
    // 2. Inspect the session orb and reuse it when present.
    const id = orbId;
    const existing = await orbital.inspect({ orbId: id });
    if (!existing) {
      if (!demand.explicit && current.allocation !== "neverRequested") {
        throw new OrbitalError("not_started", "missing", "The previously requested orb is missing. Create it explicitly.");
      }
      // 3. Resolve creation inputs only for an absent orb.
      const { options, preparation } = await resolveNewAllocationInputs();
      // 4. Save requested before submission. Implicit demand cannot retry that state.
      persistControl({ ...current, route: "remote", allocation: "requested" });
      const orb = await orbital.create({ orbId: id, image: options.image, preparation, leaseWindowMs: options.leaseWindowMs,
        env: options.env }, { signal });
      if (orb.orbId !== id) throw new Error("Orbital returned an unexpected orb ID.");
    }
    // 5. Validate the selected directory, then save attached.
    const workspace = await orbital.openWorkspace({ orbId: id, orbCwd: defaultRemoteDirectory }, { signal });
    const selected = await workspace.validateDirectory(chooseAttachmentDirectory(demand, current, existing !== undefined));
    persistControl({ ...current, route: "remote", allocation: "attached", orbCwd: selected });
    return Object.freeze({ orbId: id, orbCwd: selected });
  }
  // An explicit directory wins. Otherwise an existing orb keeps the retained directory and a
  // new orb starts at the default.
  function chooseAttachmentDirectory(demand: { explicit: boolean; directory?: string }, current: SessionControl,
    orbExists: boolean): string {
    if (demand.explicit && demand.directory !== undefined) return demand.directory;
    return orbExists ? current.orbCwd : defaultRemoteDirectory;
  }
  // 3. Shared in-process activation.
  // Acquire a remote workspace. Callers select the route before entering here.
  async function acquireRemoteWorkspace(observer: Observer = {}): Promise<Workspace> {
    const current = control();
    let target: AttachedOrb;
    if (current.allocation === "attached") target = attachment();
    else {
      // Concurrent callers share the first caller's attachment signal until this attempt settles.
      attachmentInFlight ??= attachSessionOrb(observer.signal, { explicit: false }).finally(() => { attachmentInFlight = undefined; });
      target = await attachmentInFlight;
    }
    return orbital.openWorkspace(target, observer);
  }
  async function explicitlyAttachSessionOrb(orbCwd?: string, signal?: AbortSignal): Promise<AttachedOrb> {
    if (attachmentInFlight) throw new OrbitalError("not_started", "busy", "Orbital activation is in progress.");
    attachmentInFlight = attachSessionOrb(signal, { explicit: true, directory: orbCwd }).finally(() => { attachmentInFlight = undefined; });
    return attachmentInFlight;
  }
  // 4. Restoration and the integration surface.
  return {
    get controlState() { return controlState; },
    control,
    attachment,
    // Restore control from the current branch on session start and tree navigation.
    async restore(ctx: ExtensionContext, reason: string) {
      orbId = ctx.sessionManager.getSessionId();
      // Restore drops the reference to an in-flight attachment so a branch or session change never
      // adopts it. It does not abort that attempt: the navigation guards in extension.ts refuse
      // switch, fork, and tree moves while any tracked call, including that attempt, is active.
      attachmentInFlight = undefined;
      controlState = restoreSessionControl(ctx.sessionManager.getBranch());
      if (controlState.kind !== "unbound") return;
      // autoOn seeds route intent for a fresh session. It does not attach anything.
      const shouldSeedRouteFromAutoOn = isFreshSessionForRouteDefault(ctx, reason);
      const options = shouldSeedRouteFromAutoOn ? await getOptions() : undefined;
      persistControl(initialControl(options?.autoOn ? "remote" : "local"));
    },
    // Persist route intent only. Nothing is created, deleted, or detached.
    setRoute(route: "local" | "remote") { persistControl({ ...control(), route }); },
    // Remote workspace for implicit demand, attaching through the shared attempt when needed.
    workspace: acquireRemoteWorkspace,
    // Explicit inspect, reuse or create, validate, and switch to remote. Not unconditional creation.
    create: explicitlyAttachSessionOrb,
    // Persist a directory the caller already validated against the attached orb.
    select(orbCwd: string) { persistControl({ ...control(), orbCwd }); return attachment(); },
  };
}
