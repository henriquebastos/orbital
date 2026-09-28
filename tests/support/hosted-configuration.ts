import { createE2BImages, OrbitalError } from "@henriquebastosnet/orbital";
import { createOrbitalConfiguration } from "@henriquebastosnet/orbital/settings/node";
import { saveReceipt } from "./receipts.js";

export async function hostedConfiguration(override?: string) {
  try {
    const configuration = createOrbitalConfiguration();
    const e2b = configuration.e2b();
    const images = createE2BImages({ ...e2b, cacheDirectory: configuration.cacheDirectory });
    const image = await images.ensure({ image: await configuration.image(override) });
    return { ...e2b, image: image.reference };
  } catch (cause) {
    saveReceipt("hosted-configuration", { status: "failed",
      reason: cause instanceof Error ? cause.message : "Hosted configuration failed.",
      evidence: cause instanceof OrbitalError ? cause.evidence : undefined,
      cleanup: "No test allocations created", skips: [] });
    throw cause;
  }
}
