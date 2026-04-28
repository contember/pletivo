import { defineConfig } from "astro/config";
import { agentsSummary } from "@nuasite/agent-summary";

export default defineConfig({
  site: "https://example.com",
  integrations: [agentsSummary()],
});
