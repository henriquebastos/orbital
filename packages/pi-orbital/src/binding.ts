import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

// Keep the legacy entry name: records now store session control, not provider identity.
const sessionControlEntryType = "orbital.binding";
const absoluteRemoteDirectorySchema = Type.String({ pattern: "^/[^\\u0000]*$" });
const legacyDirectorySchema = Type.Object({ orbCwd: absoluteRemoteDirectorySchema }, { additionalProperties: false });
const sessionControlSchema = Type.Object({
  version: Type.Literal(1),
  route: Type.Union([Type.Literal("local"), Type.Literal("remote")]),
  allocation: Type.Union([Type.Literal("neverRequested"), Type.Literal("requested"), Type.Literal("attached")]),
  orbCwd: absoluteRemoteDirectorySchema,
}, { additionalProperties: false });

// Three vocabularies share the legacy "binding" name:
// - SessionControl: durable route and allocation knowledge saved in session history.
// - BindingState: whether branch history supplies usable control.
// - Binding: current session identity plus the selected remote directory, derived when attached.
// None of them represents provider health.
export type Binding = Readonly<{ orbId: string; orbCwd: string }>;
export type SessionControl = Readonly<Static<typeof sessionControlSchema>>;
// "valid" means schema-valid control, not an attached or healthy provider resource.
export type BindingState =
  | { kind: "unbound" }
  | { kind: "valid"; control: SessionControl }
  | { kind: "invalid"; entryId: string };

export function restoreBinding(entries: readonly SessionEntry[]): BindingState {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "custom" || entry.customType !== sessionControlEntryType) continue;
    if (Check(sessionControlSchema, entry.data)) return { kind: "valid", control: Object.freeze({ ...entry.data }) };
    if (Check(legacyDirectorySchema, entry.data)) return { kind: "valid", control: Object.freeze({
      version: 1, route: "remote", allocation: "attached", orbCwd: entry.data.orbCwd,
    }) };
    return { kind: "invalid", entryId: entry.id };
  }
  return { kind: "unbound" };
}

export function saveBinding(pi: Pick<ExtensionAPI, "appendEntry">, control: SessionControl): SessionControl {
  if (!Check(sessionControlSchema, control)) throw new Error("Invalid Orbital session state.");
  pi.appendEntry(sessionControlEntryType, control);
  return Object.freeze({ ...control });
}
