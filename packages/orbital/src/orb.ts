/**
 * A live Orb observed through its provider. An allocation without saved creation intent is invalid metadata,
 * so, like a duplicate Orb ID, it is not reachable or deletable through Orbital.
 */
export interface OrbSnapshot {
  orbId: string;
  resourceId: string;
  image: string;
  state: "running" | "sleeping";
  leaseWindowMs: number;
  sandboxDomain?: string;
  resources?: { cpuCount: number; memoryMB: number };
  creationIntent: CreationIntent;
}

export interface CreationIntent {
  image?: string;
  preparationHash?: string;
}

export function decideDemand(state: "running" | "sleeping" | "missing") {
  switch (state) {
    case "running": return "execute";
    case "sleeping": return "resume";
    case "missing": return "reject";
  }
}
