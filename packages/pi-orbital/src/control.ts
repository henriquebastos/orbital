import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

// Session control is the durable record of route and allocation knowledge. It never stores
// provider identity: the Orb ID is always the current session ID.
const sessionControlEntryType = "orbital.control";
const absoluteRemoteDirectorySchema = Type.String({ pattern: "^/[^\\u0000]*$" });
const sessionControlSchema = Type.Object({
  version: Type.Literal(1),
  route: Type.Union([Type.Literal("local"), Type.Literal("remote")]),
  allocation: Type.Union([Type.Literal("neverRequested"), Type.Literal("requested"), Type.Literal("attached")]),
  orbCwd: absoluteRemoteDirectorySchema,
}, { additionalProperties: false });

export type SessionControl = Readonly<Static<typeof sessionControlSchema>>;
// What the current branch history supplies. "valid" means schema-valid control, not an
// attached or healthy provider resource.
export type ControlState =
  | { kind: "unbound" }
  | { kind: "valid"; control: SessionControl }
  | { kind: "invalid"; entryId: string };
// The orb a session works in, derived from control only while allocation is attached.
export type AttachedOrb = Readonly<{ orbId: string; orbCwd: string }>;

// The newest control entry on the branch is authoritative. An invalid newest entry fails closed.
export function restoreSessionControl(entries: readonly SessionEntry[]): ControlState {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "custom" || entry.customType !== sessionControlEntryType) continue;
    if (Check(sessionControlSchema, entry.data)) return { kind: "valid", control: Object.freeze({ ...entry.data }) };
    return { kind: "invalid", entryId: entry.id };
  }
  return { kind: "unbound" };
}

export function saveSessionControl(pi: Pick<ExtensionAPI, "appendEntry">, control: SessionControl): SessionControl {
  if (!Check(sessionControlSchema, control)) throw new Error("Invalid Orbital session state.");
  pi.appendEntry(sessionControlEntryType, control);
  return Object.freeze({ ...control });
}
