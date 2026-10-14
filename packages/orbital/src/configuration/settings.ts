export interface SettingDefinition<T> {
  environment: string;
  defaultValue: T;
  parseSaved(value: unknown): T;
  parseEnvironment(value: string): T;
}

export type SettingsSchema<T extends object> = {
  [K in keyof T]-?: SettingDefinition<T[K]>;
};

export interface SettingsDiagnostic {
  source: "user" | "userProject" | "project" | "environment";
  key?: string;
  message: string;
  path?: string;
}

export interface SettingsSnapshot<T extends object> {
  saved: Partial<T>;
  userProject?: Partial<T>;
  project?: Partial<T>;
  effective: T;
  source: { [K in keyof T]-?: "default" | "user" | "userProject" | "project" | "environment" };
  diagnostics: SettingsDiagnostic[];
}

export interface SettingsSources {
  user?: unknown;
  userProject?: unknown;
  project?: unknown;
  environment?: Record<string, string | undefined>;
}

export interface ImageResources {
  cpuCount: number;
  memoryMB: number;
  minFreeDiskMb?: number;
}

export interface OrbitalSettings extends ImageResources {
  image?: string;
  idleTimeoutMs: number;
  forwardEnv: string[];
}

function nonemptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("must be a nonempty string");
  return value;
}

function idleTimeout(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 3) throw new Error("must be a safe integer of at least 3 milliseconds");
  return value as number;
}

function environmentNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(name => typeof name !== "string" || !name || name.includes("=") || name.includes("\0"))) {
    throw new Error("forwardEnv must be an array of process environment variable names.");
  }
  return [...new Set(value)];
}

function resourceInteger(name: string, minimum: number, defaultValue: number): SettingDefinition<number> {
  const parseSaved = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
      throw new Error(`${name} must be a safe integer of at least ${minimum}.`);
    }
    return value as number;
  };
  return { environment: name, defaultValue, parseSaved,
    parseEnvironment(value) {
      if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must contain decimal digits only.`);
      return parseSaved(Number(value));
    } };
}

export const orbitalSettingsSchema: SettingsSchema<OrbitalSettings> = {
  cpuCount: resourceInteger("ORBITAL_CPU_COUNT", 1, 2),
  memoryMB: resourceInteger("ORBITAL_MEMORY_MB", 128, 1024),
  minFreeDiskMb: { ...resourceInteger("ORBITAL_MIN_FREE_DISK_MB", 0, 0), defaultValue: undefined },
  forwardEnv: {
    environment: "ORBITAL_FORWARD_ENV",
    // Forwarding is explicit. E2B creation requires callers to select its renewal key.
    defaultValue: [],
    parseSaved: environmentNames,
    parseEnvironment(value) {
      return environmentNames(value.trim() === "" ? [] : value.split(",").map(name => name.trim()));
    },
  },
  image: {
    environment: "ORBITAL_IMAGE",
    defaultValue: undefined,
    parseSaved: nonemptyString,
    parseEnvironment: nonemptyString,
  },
  idleTimeoutMs: {
    environment: "ORBITAL_IDLE_TIMEOUT_MS",
    defaultValue: 60_000,
    parseSaved: idleTimeout,
    parseEnvironment(value) {
      if (!/^[0-9]+$/.test(value)) throw new Error("must contain decimal digits only");
      return idleTimeout(Number(value));
    },
  },
};

export function resolveSettings<T extends object>(schema: SettingsSchema<T>, sources: SettingsSources): SettingsSnapshot<T> {
  const saved: Partial<T> = {};
  const effective = {} as T;
  const source = {} as SettingsSnapshot<T>["source"];
  const diagnostics: SettingsDiagnostic[] = [];
  const userProject: Partial<T> = {};
  const project: Partial<T> = {};
  const savedLayers = { user: saved, userProject, project };
  // Select one project layer as a whole, even when its values are empty or invalid.
  const projectSource = sources.project !== undefined ? "project" : "userProject";
  const layers = (["user", projectSource] as const).map(name => {
    const input = sources[name];
    const valid = input === undefined || (input !== null && typeof input === "object" && !Array.isArray(input));
    if (!valid) diagnostics.push({ source: name, message: "must be a JSON object" });
    const values = valid && input !== undefined ? input as Record<string, unknown> : {};
    return { name, values, saved: savedLayers[name] };
  });

  for (const key of Object.keys(schema) as (keyof T & string)[]) {
    const definition = schema[key];
    effective[key] = definition.defaultValue;
    source[key] = "default";
    for (const layer of layers) {
      if (!Object.hasOwn(layer.values, key)) continue;
      try {
        const value = definition.parseSaved(layer.values[key]);
        layer.saved[key] = value;
        effective[key] = value;
        source[key] = layer.name;
      } catch {
        diagnostics.push({ source: layer.name, key, message: `Invalid saved setting: ${key}.` });
      }
    }
    const rawEnvironment = sources.environment?.[definition.environment];
    if (rawEnvironment !== undefined) {
      try {
        effective[key] = definition.parseEnvironment(rawEnvironment);
        source[key] = "environment";
      } catch {
        diagnostics.push({ source: "environment", key, message: `Invalid environment setting: ${definition.environment}.` });
      }
    }
  }

  for (const layer of layers) {
    for (const key of Object.keys(layer.values)) {
      if (!Object.hasOwn(schema, key)) diagnostics.push({ source: layer.name, key, message: "is not a known setting" });
    }
  }

  return { saved, ...(projectSource !== "userProject" || sources.userProject === undefined ? {} : { userProject }),
    ...(sources.project === undefined ? {} : { project }), effective, source, diagnostics };
}
