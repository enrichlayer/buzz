import { TEST_IDENTITIES } from "./bridge";

export const SUGGESTION_AGENT = TEST_IDENTITIES.alice.pubkey;
export const SUGGESTION_PROMPT =
  "Can the label use the account's name instead of repeating the email?";
export const SUGGESTION_ANSWER = `Done. The account label now follows login changes.\n\n\`\`\`suggested-prompts\n${JSON.stringify({ version: 1, suggestions: [{ label: "Use the account name", prompt: SUGGESTION_PROMPT }] })}\n\`\`\``;
