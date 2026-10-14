import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CreateRequest, Observer, OrbSnapshot, Workspace } from "@henriquebastosnet/orbital";
import type { ImageResources } from "@henriquebastosnet/orbital/settings";
import { createPiSession } from "./session.js";
import { createToolRegistration } from "./registration.js";
import { createRoutingStatus, registerOrbCommand, registerWorkspacePromptSection } from "./status.js";
import { registerUserShell } from "./user-shell.js";
import { registerControlTools } from "./control-tools.js";
import { registerWorkspaceTools } from "./workspace-tools.js";
import type { PiSettingsControl } from "./preferences.js";

export interface PiOrbitalApi {
  create(request: CreateRequest, observer?: Observer): Promise<OrbSnapshot>;
  inspect(request: { orbId: string }): Promise<OrbSnapshot | undefined>;
  delete(request: { orbId: string }): Promise<void>;
  url(request: { orbId: string; port: number }): Promise<string>;
  openWorkspace(request: { orbId: string; orbCwd: string }, observer?: Observer): Promise<Workspace>;
}

export interface PiOptions extends Partial<ImageResources> {
  image?: string;
  preparation?: () => Promise<string | undefined>;
  env?: Record<string, string>;
  leaseWindowMs: number;
  autoOn?: boolean;
  skillRoots?: readonly string[];
  creationProblem?: string;
  remoteProblem?: string;
}

// Composition of the Pi integration: session control, tracked registration, routing status,
// the /orb command and prompt section, the user shell, control tools, then workspace tools.
export function registerOrbitalPi(pi: ExtensionAPI, orbital: PiOrbitalApi,
  options: PiOptions | (() => PiOptions | Promise<PiOptions>),
  settingsControl?: PiSettingsControl,
): void {
  const getOptions = async () => typeof options === "function" ? options() : options;
  const session = createPiSession(pi, orbital, getOptions);
  const registration = createToolRegistration(pi, session);
  const status = createRoutingStatus(session, getOptions, registration);

  // Lifecycle and navigation guards.
  pi.on("session_start", (event, ctx) => session.restore(ctx, event.reason));
  pi.on("session_tree", (_event, ctx) => session.restore(ctx, "tree"));
  pi.on("session_before_switch", () => registration.activeCalls() ? { cancel: true } : undefined);
  pi.on("session_before_fork", () => registration.activeCalls() ? { cancel: true } : undefined);
  pi.on("session_before_tree", () => registration.activeCalls() ? { cancel: true } : undefined);

  registerOrbCommand(pi, status, settingsControl);
  registerWorkspacePromptSection(pi, session);
  registerUserShell(pi, session, registration);
  registerControlTools(pi, { session, orbital, getOptions, status, registration, settingsControl });
  registerWorkspaceTools(pi, session, registration);
}
