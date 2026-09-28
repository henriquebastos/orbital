import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { OrbitalError, type Observer, type Workspace } from "@henriquebastosnet/orbital";
import type { PiOptions, PiOrbitalApi } from "./extension.js";
import { restoreBinding, saveBinding, type Binding, type BindingState, type SessionControl } from "./binding.js";

export function createPiSession(pi: ExtensionAPI, orbital: PiOrbitalApi,
  getOptions: () => Promise<PiOptions>) {
  let state: BindingState = { kind: "unbound" };
  let orbId = "";
  let activation: Promise<Binding> | undefined;
  const initial = (route: "local" | "remote"): SessionControl => ({
    version: 1, route, allocation: "neverRequested", orbCwd: "/home/user",
  });
  function control(): SessionControl {
    if (state.kind === "invalid") throw new OrbitalError("not_started", "invalid_binding",
      "The saved Orbital binding is invalid. Attach explicitly to continue.");
    return state.kind === "valid" ? state.control : initial("local");
  }
  function save(next: SessionControl): void {
    state = { kind: "valid", control: saveBinding(pi, next) };
  }
  function binding(): Binding {
    const current = control();
    if (current.allocation !== "attached") throw new OrbitalError("not_started", "unbound", "No orb is attached.");
    return Object.freeze({ orbId, orbCwd: current.orbCwd });
  }
  async function attach(signal?: AbortSignal, explicitDirectory?: string): Promise<Binding> {
    const current = explicitDirectory !== undefined && state.kind === "invalid" ? initial("remote") : control();
    if (explicitDirectory === undefined && current.allocation === "requested") {
      throw new OrbitalError("not_started", "allocation_unresolved",
        "The previous allocation request is unresolved. Inspect the orb and use create_and_attach explicitly to recover.");
    }
    if (explicitDirectory !== undefined && state.kind !== "invalid" && current.route !== "remote") {
      save({ ...current, route: "remote" });
    }
    const id = orbId;
    const existing = await orbital.inspect({ orbId: id });
    if (!existing) {
      if (explicitDirectory === undefined && current.allocation !== "neverRequested") {
        throw new OrbitalError("not_started", "missing", "The previously requested orb is missing. Create it explicitly.");
      }
      const options = await getOptions();
      if (options.creationProblem) throw new OrbitalError("not_started", "configuration", options.creationProblem);
      save({ ...current, route: "remote", allocation: "requested" });
      const orb = await orbital.create({ orbId: id, image: options.image, idleTimeoutMs: options.idleTimeoutMs }, { signal });
      if (orb.orbId !== id) throw new Error("Orbital returned an unexpected orb ID.");
    }
    const workspace = await orbital.openWorkspace({ orbId: id, orbCwd: "/home/user" }, { signal });
    const selected = await workspace.validateDirectory(explicitDirectory ?? current.orbCwd);
    save({ ...current, route: "remote", allocation: "attached", orbCwd: selected });
    return Object.freeze({ orbId: id, orbCwd: selected });
  }
  return {
    get state() { return state; },
    control,
    binding,
    async restore(ctx: ExtensionContext, reason: string) {
      orbId = ctx.sessionManager.getSessionId();
      activation = undefined;
      state = restoreBinding(ctx.sessionManager.getBranch());
      if (state.kind !== "unbound") return;
      const file = ctx.sessionManager.getSessionFile();
      const fresh = reason === "new" || (reason === "startup" && (!file || !existsSync(file))
        && !ctx.sessionManager.getHeader()?.parentSession
        && ctx.sessionManager.getEntries().every(entry => entry.type === "model_change" || entry.type === "thinking_level_change"));
      const options = fresh ? await getOptions() : undefined;
      save(initial(options?.autoOn ? "remote" : "local"));
    },
    setRoute(route: "local" | "remote") { save({ ...control(), route }); },
    async workspace(observer: Observer = {}): Promise<Workspace> {
      const current = control();
      let target: Binding;
      if (current.allocation === "attached") target = binding();
      else {
        activation ??= attach(observer.signal).finally(() => { activation = undefined; });
        target = await activation;
      }
      return orbital.openWorkspace(target, observer);
    },
    async create(orbCwd: string, signal?: AbortSignal) {
      if (activation) throw new OrbitalError("not_started", "busy", "Orbital activation is in progress.");
      activation = attach(signal, orbCwd).finally(() => { activation = undefined; });
      return activation;
    },
    select(orbCwd: string) { save({ ...control(), orbCwd }); return binding(); },
  };
}
