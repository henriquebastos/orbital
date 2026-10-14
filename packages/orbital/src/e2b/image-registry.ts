import { BuildError, SandboxError, Sandbox, Template } from "e2b";

import { OrbitalError } from "../operations.js";
import type { ImageBuild } from "../lifecycle/images/preparation.js";
import type { ImageArtifact } from "../lifecycle/images/records.js";
import type { E2BProviderConfig } from "./provider.js";

// E2B image identity. One reference "name[:tag]" can name three different things:
// - a captured snapshot: a sandbox snapshot listed under "name:default", whose canonical
//   snapshot ID is the template name and whose tags map to build IDs;
// - a template alias: a human name that the alias API maps to a template ID;
// - a build: one build ID of a template, with a status (waiting, building, ready, error).
// An artifact pins one build. Its reference is always "name:buildId" so a later lookup
// cannot drift to another build behind the same tag.

const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
const PAGE_LIMIT = 100;

export function imageError(outcome: "not_started" | "failed" | "uncertain", code: string, message: string,
  evidence: Record<string, unknown> = {}): OrbitalError {
  return new OrbitalError(outcome, code, message, evidence);
}

export function sdkOptions(config: E2BProviderConfig) {
  const domain = config.domain ?? "e2b.app";
  return { apiKey: config.apiKey, domain, apiUrl: config.apiUrl ?? `https://api.${domain}`,
    requestTimeoutMs: config.requestTimeoutMs, retries: 0 };
}

// Split "name[:tag]". The default tag is "default". A tag can be a build ID.
export function referenceParts(reference: string): { name: string; tag: string } {
  const colon = reference.lastIndexOf(":");
  const slash = reference.lastIndexOf("/");
  if (colon > slash) return { name: reference.slice(0, colon), tag: reference.slice(colon + 1) };
  return { name: reference, tag: "default" };
}

export const isBuildId = (tag: string): boolean => BUILD_ID.test(tag);

// A 404 from the SDK means the image, tag, or build is missing, not that the lookup failed.
export function missing(cause: unknown): boolean {
  if (cause instanceof SandboxError) return cause.statusCode === 404;
  // SDK 2.51 wraps build-status HTTP errors in BuildError without statusCode.
  return cause instanceof BuildError && /^404: /.test(cause.message);
}

export function statusCode(cause: unknown): number | undefined {
  if (cause instanceof SandboxError) return cause.statusCode;
  if (cause instanceof BuildError) {
    const match = /^(\d{3}): /.exec(cause.message);
    if (match) return Number(match[1]);
  }
  return undefined;
}

const lookupFailed = (message: string, evidence: Record<string, unknown> = {}) =>
  imageError("not_started", "image_lookup_failed", message, evidence);
const lookupEvidence = (reference: string, cause: unknown) =>
  ({ reference, cause: cause instanceof Error ? cause.name : "unknown", statusCode: statusCode(cause) });

type TemplateBuild = { buildID?: unknown; status?: unknown };
type TemplatePage = { data: unknown; nextToken?: string };

export function createImageRegistry(config: E2BProviderConfig) {
  const options = sdkOptions(config);

  // 1. Template API: alias and build listing.

  async function apiGet(path: string): Promise<TemplatePage | undefined> {
    let response: Response;
    try {
      response = await fetch(`${options.apiUrl}${path}`, {
        headers: { "X-API-KEY": config.apiKey }, signal: AbortSignal.timeout(config.requestTimeoutMs ?? 60_000),
      });
    } catch (cause) {
      throw lookupFailed("The E2B image lookup failed.", { cause: cause instanceof Error ? cause.name : "unknown" });
    }
    if (response.status === 404) return undefined;
    if (!response.ok) throw lookupFailed("E2B rejected the image lookup.", { statusCode: response.status });
    let data: unknown;
    try { data = await response.json(); }
    catch (cause) {
      throw lookupFailed("The E2B image lookup returned invalid data.",
        { statusCode: response.status, cause: cause instanceof Error ? cause.name : "unknown" });
    }
    return { data, nextToken: response.headers.get("X-Next-Token") ?? undefined };
  }

  // The template ID behind an alias, or undefined when the alias does not exist.
  async function aliasTemplateId(name: string): Promise<string | undefined> {
    const alias = await apiGet(`/templates/aliases/${encodeURIComponent(name)}`);
    if (!alias) return undefined;
    const templateId = (alias.data as { templateID?: unknown })?.templateID;
    if (typeof templateId !== "string" || !templateId) throw lookupFailed("The E2B image alias has invalid data.");
    return templateId;
  }

  // Pages of a template's builds, newest first. Yields undefined when the template is missing.
  async function* buildPages(templateId: string): AsyncGenerator<TemplateBuild[] | undefined> {
    let nextToken: string | undefined;
    for (let count = 0; count < PAGE_LIMIT; count++) {
      const page = await apiGet(`/templates/${encodeURIComponent(templateId)}?limit=100${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ""}`);
      if (!page) { yield undefined; return; }
      const data = page.data as { templateID?: unknown; builds?: TemplateBuild[] };
      if (!data || typeof data !== "object" || data.templateID !== templateId || !Array.isArray(data.builds)) {
        throw lookupFailed("The E2B image build list has invalid data.");
      }
      yield data.builds;
      nextToken = page.nextToken;
      if (!nextToken) return;
    }
    throw lookupFailed("The E2B image build list exceeded the page limit.");
  }

  // One build of a template or alias, with its status. Undefined when absent.
  async function templateBuild(name: string, buildId: string): Promise<{ templateId: string; status: string } | undefined> {
    let templateId = name;
    let pages = buildPages(templateId);
    let first = await pages.next();
    if (first.value === undefined) {
      const aliased = await aliasTemplateId(name);
      if (!aliased) return undefined;
      templateId = aliased;
      pages = buildPages(templateId);
      first = await pages.next();
      if (first.value === undefined) return undefined;
    }
    for (let page = first; !page.done; page = await pages.next()) {
      if (page.value === undefined) return undefined;
      const build = page.value.find((item) => item.buildID === buildId);
      if (build) {
        if (typeof build.status !== "string") throw lookupFailed("The E2B image build has invalid status.");
        return { templateId, status: build.status };
      }
    }
    return undefined;
  }

  // 2. Snapshots.

  // The canonical snapshot ID for a snapshot name, or undefined when no snapshot has that name.
  async function snapshotId(name: string): Promise<string | undefined> {
    try {
      const paginator = Sandbox.listSnapshots({ ...options, name, limit: 20 });
      while (paginator.hasNext) {
        const snapshots = await paginator.nextItems();
        const match = snapshots.find((snapshot) => snapshot.snapshotId === name ||
          !name.includes("/") && snapshot.snapshotId.endsWith(`/${name}`));
        if (match) return match.snapshotId;
      }
      return undefined;
    } catch (cause) {
      if (missing(cause)) return undefined;
      throw lookupFailed("The captured image could not be inspected.", lookupEvidence(name, cause));
    }
  }

  async function templateTags(name: string, reference: string, subject: "captured image tag" | "requested E2B image") {
    try { return await Template.getTags(name, options); }
    catch (cause) {
      if (missing(cause)) throw imageError("not_started", "image_missing", `The ${subject} does not exist.`, { reference });
      throw lookupFailed(`The ${subject} could not be inspected.`, lookupEvidence(reference, cause));
    }
  }

  // 3. Resolution.

  // Resolve a reference to one pinned build. Snapshot first, then a build ID tag, then a named tag.
  async function resolve(reference: string): Promise<ImageArtifact> {
    const { name, tag } = referenceParts(reference);
    const captured = await snapshotId(`${name}:default`);
    if (captured) {
      const canonicalName = referenceParts(captured).name;
      const tags = await templateTags(canonicalName, reference, "captured image tag");
      const match = isBuildId(tag) ? tags.find((item) => item.buildId === tag) : tags.find((item) => item.tag === tag);
      if (!match) throw imageError("not_started", "image_unavailable", "The captured image build is not accessible.", { reference });
      return { reference: `${canonicalName}:${match.buildId}`, templateId: canonicalName, buildId: match.buildId,
        kind: "snapshot", snapshotId: captured };
    }
    const buildId = isBuildId(tag) ? tag : (await templateTags(name, reference, "requested E2B image")).find((item) => item.tag === tag)?.buildId;
    if (!buildId) throw imageError("not_started", "image_missing", "The requested E2B image tag does not exist.", { reference });
    const build = await templateBuild(name, buildId);
    if (!build) throw imageError("not_started", "image_missing", "The requested E2B image build does not exist.", { reference });
    if (build.status !== "ready") throw imageError("not_started", "image_unavailable", "The requested E2B image is not ready.",
      { reference, status: build.status });
    return { reference: `${name}:${buildId}`, templateId: build.templateId, buildId, kind: "template" };
  }

  // Whether a pinned artifact still exists and is ready. A snapshot must still resolve to the same build.
  async function available(artifact: ImageArtifact): Promise<boolean> {
    if (artifact.kind === "snapshot") {
      const name = artifact.snapshotId ?? `${referenceParts(artifact.reference).name}:default`;
      if (!await snapshotId(name)) return false;
      const current = await resolve(artifact.reference);
      return current.kind === "snapshot" && current.buildId === artifact.buildId;
    }
    try {
      const build = await templateBuild(artifact.templateId, artifact.buildId);
      if (!build) return false;
      if (build.status !== "ready") {
        throw imageError("not_started", "image_not_ready", "The exact image build is not ready.",
          { reference: artifact.reference, status: build.status });
      }
      return true;
    } catch (cause) {
      if (missing(cause)) return false;
      if (cause instanceof OrbitalError) throw cause;
      throw lookupFailed("The exact image build could not be inspected.", lookupEvidence(artifact.reference, cause));
    }
  }

  // The most useful build of an alias: a ready build, else a pending one, else a failed one.
  async function findReusableBuild(name: string): Promise<ImageBuild | undefined> {
    const templateId = await aliasTemplateId(name);
    if (!templateId) return undefined;
    let pending: ImageBuild | undefined;
    let failed: ImageBuild | undefined;
    for await (const builds of buildPages(templateId)) {
      if (builds === undefined) throw lookupFailed("The E2B image disappeared during lookup.");
      for (const build of builds) {
        if (!build || typeof build.buildID !== "string" || !build.buildID ||
          !["waiting", "building", "ready", "error"].includes(build.status as string)) {
          throw lookupFailed("The E2B image build has invalid data.");
        }
        const result: ImageBuild = { artifact: { reference: `${name}:${build.buildID}`, templateId,
          buildId: build.buildID, kind: "template" }, status: build.status as ImageBuild["status"] };
        if (result.status === "ready") return result;
        if (result.status === "error") failed ??= result;
        else pending ??= result;
      }
    }
    if (pending || failed) return pending ?? failed;
    throw lookupFailed("The E2B image has no visible builds.");
  }

  return { resolve, available, findReusableBuild };
}
