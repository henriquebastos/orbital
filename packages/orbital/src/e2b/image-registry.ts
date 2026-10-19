import { BuildError, SandboxError, Template } from "e2b";

import { OrbitalError } from "../operations.js";
import type { ImageBuild } from "../lifecycle/images/preparation.js";
import { artifactReference, type ImageArtifact } from "../lifecycle/images/records.js";
import type { E2BProviderConfig } from "./provider.js";

// E2B image identity. A reference "name[:tag]" names a template through its alias (an owned base
// name, a captured snapshot's canonical "<team>/<name>", or any user alias), or through its raw
// template ID when the tag is a build ID. A tag maps to one build of that template. An artifact pins
// one build and keeps the accepted name, so every later lookup pages the raw template's build list.
// Builds are confirmed only through that list: E2B rejects /builds/{id}/status for snapshot builds.

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

  // The status of one build of a raw template. Undefined when the template or the build is absent.
  async function buildStatus(templateId: string, buildId: string): Promise<string | undefined> {
    for await (const builds of buildPages(templateId)) {
      if (builds === undefined) return undefined;
      const build = builds.find((item) => item.buildID === buildId);
      if (build) {
        if (typeof build.status !== "string") throw lookupFailed("The E2B image build has invalid status.");
        return build.status;
      }
    }
    return undefined;
  }

  async function templateTags(name: string, reference: string) {
    try { return await Template.getTags(name, options); }
    catch (cause) {
      if (missing(cause)) throw imageError("not_started", "image_missing", "The requested E2B image does not exist.", { reference });
      throw lookupFailed("The requested E2B image could not be inspected.", lookupEvidence(reference, cause));
    }
  }

  // Resolve a reference to one pinned ready build. A raw template ID is accepted only with a build ID tag.
  async function resolve(reference: string): Promise<ImageArtifact> {
    const { name, tag } = referenceParts(reference);
    let templateId = await aliasTemplateId(name);
    if (templateId === undefined) {
      if (!isBuildId(tag)) throw imageError("not_started", "image_missing", "The requested E2B image does not exist.", { reference });
      templateId = name;
    }
    const buildId = isBuildId(tag) ? tag : (await templateTags(name, reference)).find((item) => item.tag === tag)?.buildId;
    if (!buildId) throw imageError("not_started", "image_missing", "The requested E2B image tag does not exist.", { reference });
    const status = await buildStatus(templateId, buildId);
    if (status === undefined) throw imageError("not_started", "image_missing", "The requested E2B image build does not exist.", { reference });
    if (status !== "ready") throw imageError("not_started", "image_unavailable", "The requested E2B image is not ready.", { reference, status });
    return { name, templateId, buildId };
  }

  // Whether a pinned artifact still exists and is ready. Absent is false. Another status is an error.
  async function available(artifact: ImageArtifact): Promise<boolean> {
    const status = await buildStatus(artifact.templateId, artifact.buildId);
    if (status === undefined) return false;
    if (status !== "ready") {
      throw imageError("not_started", "image_not_ready", "The exact image build is not ready.",
        { reference: artifactReference(artifact), status });
    }
    return true;
  }

  // The artifact behind a snapshot ID that createSnapshot returned ("<team>/<name>:<tag>").
  async function captured(snapshotId: string): Promise<ImageArtifact> {
    const { name, tag } = referenceParts(snapshotId);
    const templateId = await aliasTemplateId(name);
    if (templateId === undefined) throw lookupFailed("The captured image has no alias.", { reference: snapshotId });
    const buildId = (await templateTags(name, snapshotId)).find((item) => item.tag === tag)?.buildId;
    if (!buildId) throw lookupFailed("The captured image tag has no build.", { reference: snapshotId });
    return { name, templateId, buildId };
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
        const result: ImageBuild = { artifact: { name, templateId, buildId: build.buildID },
          status: build.status as ImageBuild["status"] };
        if (result.status === "ready") return result;
        if (result.status === "error") failed ??= result;
        else pending ??= result;
      }
    }
    if (pending || failed) return pending ?? failed;
    throw lookupFailed("The E2B image has no visible builds.");
  }

  return { resolve, available, captured, findReusableBuild };
}
