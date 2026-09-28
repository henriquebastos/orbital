export interface OrbSnapshot {
  orbId: string;
  resourceId: string;
  image: string;
  state: "running" | "sleeping";
  idleTimeoutMs: number;
  sandboxDomain?: string;
  creationIntent?: CreationIntent;
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
