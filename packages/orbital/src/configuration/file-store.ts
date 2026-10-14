import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveSettings, type SettingsDiagnostic, type SettingsSchema, type SettingsSnapshot, type SettingsSources } from "./settings.js";

export interface NodeSettingsOptions<T extends object> {
  schema: SettingsSchema<T>;
  directory?: string;
  fileName?: string;
  userProjectFilePath?: string;
  projectFilePath?: string;
  environment?: Record<string, string | undefined>;
}

export interface NodeSettings<T extends object> {
  readonly filePath: string;
  readonly userProjectFilePath?: string;
  readonly projectFilePath?: string;
  readonly selectedProjectFilePath?: string;
  snapshot(): SettingsSnapshot<T>;
  refresh(): Promise<SettingsSnapshot<T>>;
  set<K extends keyof T>(key: K, value: T[K]): Promise<SettingsSnapshot<T>>;
  unset(key: keyof T): Promise<SettingsSnapshot<T>>;
}

const pendingSettingsAccess = new Map<string, Promise<void>>();

async function serializeSettingsAccess<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = pendingSettingsAccess.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pendingSettingsAccess.set(path, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pendingSettingsAccess.get(path) === current) pendingSettingsAccess.delete(path);
  }
}

export function settingsDirectory(environment: Record<string, string | undefined> = process.env): string {
  const base = environment.XDG_CONFIG_HOME;
  return join(base && isAbsolute(base) ? base : join(homedir(), ".config"), "orbital");
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseText(path: string, text: string | undefined, source: Exclude<SettingsDiagnostic["source"], "environment"> = "user"): { user: unknown; diagnostics: SettingsDiagnostic[] } {
  if (text === undefined) return { user: {}, diagnostics: [] };
  try {
    return { user: JSON.parse(text) as unknown, diagnostics: [] };
  } catch {
    return { user: {}, diagnostics: [{ source, path, message: "contains malformed JSON" }] };
  }
}

export function createNodeSettings<T extends object>(options: NodeSettingsOptions<T>): NodeSettings<T> {
  const environment = options.environment ?? process.env;
  const directory = options.directory ?? settingsDirectory(environment);
  const fileName = options.fileName ?? "settings.json";
  if (!isAbsolute(directory)) throw new Error("The settings directory must be an absolute path.");
  if (!fileName || fileName === "." || fileName === ".." || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error("The settings file name must be a single path segment.");
  }
  const filePath = join(directory, fileName);
  const { userProjectFilePath, projectFilePath } = options;
  const projectCandidates = [
    { source: "project", path: projectFilePath },
    { source: "userProject", path: userProjectFilePath },
  ] as const;
  for (const { path } of projectCandidates) {
    if (path !== undefined && !isAbsolute(path)) throw new Error("The project settings path must be absolute.");
  }
  const projectValues: Pick<SettingsSources, "userProject" | "project"> = {};
  let projectDiagnostics: SettingsDiagnostic[] = [];
  let loaded = false;
  let revision: string | undefined;
  let user: unknown = {};
  let current = resolveSettings(options.schema, { environment });
  let invalidUser = false;

  function updateSnapshotFromUserText(text: string | undefined, readDiagnostics: SettingsDiagnostic[] = []): SettingsSnapshot<T> {
    const parsed = parseText(filePath, text);
    user = parsed.user;
    current = resolveSettings(options.schema, { user, ...projectValues, environment });
    current.diagnostics = [
      ...readDiagnostics,
      ...parsed.diagnostics,
      ...projectDiagnostics,
      ...current.diagnostics.map(diagnostic => diagnostic.source === "user" ? { ...diagnostic, path: filePath }
        : diagnostic.source === "userProject" ? { ...diagnostic, path: userProjectFilePath }
        : diagnostic.source === "project" ? { ...diagnostic, path: projectFilePath } : diagnostic),
    ];
    // Only a file that cannot be rewritten safely blocks edits: unreadable, malformed, or not an
    // object. An invalid value under one key stays as written while another key is edited.
    const rewritable = typeof user === "object" && user !== null && !Array.isArray(user);
    invalidUser = !rewritable || readDiagnostics.length > 0 || parsed.diagnostics.length > 0;
    revision = text;
    loaded = true;
    return structuredClone(current);
  }

  async function refresh(): Promise<SettingsSnapshot<T>> {
    return serializeSettingsAccess(filePath, async () => {
      projectDiagnostics = [];
      delete projectValues.project;
      delete projectValues.userProject;
      for (const { source, path } of projectCandidates) {
        if (path === undefined) continue;
        try {
          const text = await readText(path);
          if (text === undefined) continue;
          const parsed = parseText(path, text, source);
          projectValues[source] = parsed.user;
          projectDiagnostics.push(...parsed.diagnostics);
        } catch {
          projectValues[source] = {};
          projectDiagnostics.push({ source, path, message: "Cannot read project settings file." });
        }
        // A present or unreadable candidate selects the project directory. Do not merge or fall back.
        break;
      }
      try {
        return updateSnapshotFromUserText(await readText(filePath));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return updateSnapshotFromUserText(undefined, [{ source: "user", path: filePath, message: `Cannot read settings file (${code ?? "unknown error"})` }]);
      }
    });
  }

  function snapshot(): SettingsSnapshot<T> {
    if (!loaded) throw new Error("Refresh settings before reading the snapshot.");
    return structuredClone(current);
  }

  async function change(key: keyof T, value: T[keyof T] | undefined, remove: boolean): Promise<SettingsSnapshot<T>> {
    if (!loaded) throw new Error("Refresh settings before editing.");
    if (!Object.hasOwn(options.schema, key)) throw new Error(`Unknown setting: ${String(key)}`);
    const parsedValue = remove ? undefined : options.schema[key].parseSaved(value);
    return serializeSettingsAccess(filePath, async () => {
      if (invalidUser) {
        throw new Error(`Cannot edit invalid settings at ${filePath}: the file is unreadable, malformed, or not an object.`);
      }
      if (await readText(filePath) !== revision) throw new Error(`Settings changed on disk at ${filePath}; refresh before editing.`);
      const next = { ...user as Record<string, unknown> };
      if (remove) delete next[key as string];
      else next[key as string] = parsedValue;
      const text = `${JSON.stringify(next, null, 2)}\n`;
      await mkdir(directory, { recursive: true });
      const temporaryPath = join(directory, `.${fileName}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, text, { flag: "wx", mode: 0o600 });
        await rename(temporaryPath, filePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
      return updateSnapshotFromUserText(text);
    });
  }

  return {
    filePath,
    userProjectFilePath,
    projectFilePath,
    get selectedProjectFilePath() {
      return current.project !== undefined ? projectFilePath : current.userProject !== undefined ? userProjectFilePath : undefined;
    },
    snapshot,
    refresh,
    set: (key, value) => change(key, value, false),
    unset: key => change(key, undefined, true),
  };
}
