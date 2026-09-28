import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const entryType = "orbital.binding";
const directory = Type.String({ pattern: "^/[^\\u0000]*$" });
const legacySchema = Type.Object({ orbCwd: directory }, { additionalProperties: false });
const savedSchema = Type.Object({
  version: Type.Literal(1),
  route: Type.Union([Type.Literal("local"), Type.Literal("remote")]),
  allocation: Type.Union([Type.Literal("neverRequested"), Type.Literal("requested"), Type.Literal("attached")]),
  orbCwd: directory,
}, { additionalProperties: false });

export type Binding = Readonly<{ orbId: string; orbCwd: string }>;
export type SessionControl = Readonly<Static<typeof savedSchema>>;
export type BindingState =
  | { kind: "unbound" }
  | { kind: "valid"; control: SessionControl }
  | { kind: "invalid"; entryId: string };

export function restoreBinding(entries: readonly SessionEntry[]): BindingState {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "custom" || entry.customType !== entryType) continue;
    if (Check(savedSchema, entry.data)) return { kind: "valid", control: Object.freeze({ ...entry.data }) };
    if (Check(legacySchema, entry.data)) return { kind: "valid", control: Object.freeze({
      version: 1, route: "remote", allocation: "attached", orbCwd: entry.data.orbCwd,
    }) };
    return { kind: "invalid", entryId: entry.id };
  }
  return { kind: "unbound" };
}

export function saveBinding(pi: Pick<ExtensionAPI, "appendEntry">, control: SessionControl): SessionControl {
  if (!Check(savedSchema, control)) throw new Error("Invalid Orbital session state.");
  pi.appendEntry(entryType, control);
  return Object.freeze({ ...control });
}
