import type { ArtifactTypePolicy } from "./types";

export const ARTIFACT_TYPE_AGENT_PROMPT = "buzz.agent_prompt";

/** An agent's question to the channel; the first answer wins (DEV-11200). */
export const agentPromptPolicy = {
  id: "agent-prompt",
  type: ARTIFACT_TYPE_AGENT_PROMPT,
} as const satisfies ArtifactTypePolicy;
