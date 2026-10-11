import { openrouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

export default defineAgent({
  model: openrouter("deepseek/deepseek-v4.1-flash"),
  // eve looks up context windows in the AI Gateway catalog, which doesn't cover OpenRouter models.
  modelContextWindowTokens: 1_048_576,
});
