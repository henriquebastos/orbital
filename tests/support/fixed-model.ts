import { readFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerFixedModel(pi: ExtensionAPI): void {
  const source = process.env.ORBITAL_PI_CALLS_FILE
    ? readFileSync(process.env.ORBITAL_PI_CALLS_FILE, "utf8")
    : process.env.ORBITAL_PI_CALLS ?? "[]";
  const calls = JSON.parse(source) as ({ name: string; arguments: ToolCall["arguments"] } | null)[];
  let index = 0;
  pi.registerProvider("orbital-fixture", {
    baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", api: "orbital-fixture" as never,
    models: [{ id: "probe", name: "Orbital fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000,
      maxTokens: 4096 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const call = calls[index++];
      const emit = () => {
        const toolCall: ToolCall | undefined = call
          ? { type: "toolCall", id: `fixture-${index}`, name: call.name, arguments: call.arguments }
          : undefined;
        const output: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider,
          model: model.id, content: toolCall ? [toolCall] : [{ type: "text", text: "FIXTURE_DONE" }],
          stopReason: toolCall ? "toolUse" : "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: output });
        if (toolCall) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        stream.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message: output });
        stream.end();
      };
      const delay = Number(process.env.ORBITAL_PI_MODEL_DELAY_MS ?? "0");
      if (delay) setTimeout(emit, delay);
      else queueMicrotask(emit);
      return stream;
    },
  });
}
