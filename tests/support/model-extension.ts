import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import orbitalExtension from "@henriquebastosnet/pi-orbital";
import { registerFixedModel } from "./fixed-model.js";

export default function modelExtension(pi: ExtensionAPI): void {
  orbitalExtension(pi);
  registerFixedModel(pi);
}
