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
  source: "user" | "environment";
  key?: string;
  message: string;
  path?: string;
}

export interface SettingsSnapshot<T extends object> {
  saved: Partial<T>;
  effective: T;
  source: { [K in keyof T]-?: "default" | "user" | "environment" };
  diagnostics: SettingsDiagnostic[];
}

export interface SettingsSources {
  user?: unknown;
  environment?: Record<string, string | undefined>;
}

export interface OrbitalSettings {
  image?: string;
  idleTimeoutMs: number;
}

function nonemptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("must be a nonempty string");
  return value;
}

function idleTimeout(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 3) throw new Error("must be a safe integer of at least 3 milliseconds");
  return value as number;
}

export const orbitalSettingsSchema: SettingsSchema<OrbitalSettings> = {
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
  const validUser = sources.user === undefined ||
    (sources.user !== null && typeof sources.user === "object" && !Array.isArray(sources.user));
  const user = validUser && sources.user !== undefined ? sources.user as Record<string, unknown> : {};
  if (!validUser) diagnostics.push({ source: "user", message: "must be a JSON object" });

  for (const key of Object.keys(schema) as (keyof T & string)[]) {
    const definition = schema[key];
    effective[key] = definition.defaultValue;
    source[key] = "default";
    if (Object.hasOwn(user, key)) {
      try {
        const value = definition.parseSaved(user[key]);
        saved[key] = value;
        effective[key] = value;
        source[key] = "user";
      } catch {
        diagnostics.push({ source: "user", key, message: `Invalid saved setting: ${key}.` });
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

  for (const key of Object.keys(user)) {
    if (!Object.hasOwn(schema, key)) diagnostics.push({ source: "user", key, message: "is not a known setting" });
  }

  return { saved, effective, source, diagnostics };
}
