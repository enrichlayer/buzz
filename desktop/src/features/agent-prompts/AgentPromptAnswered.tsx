import { CheckCircle2 } from "lucide-react";

import { useUserProfileQuery } from "@/features/profile/hooks";
import {
  resolveUserLabel,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";

import type { AgentPrompt } from "./agentPromptContent";
import { AgentPromptCardFrame } from "./AgentPromptCardFrame";

/** The winning answer, the same for every viewer. */
export function AgentPromptAnswered({
  currentPubkey,
  lostRace,
  profiles,
  prompt,
}: {
  currentPubkey?: string;
  /** Our own answer was rejected because this one landed first. */
  lostRace: boolean;
  profiles?: UserProfileLookup;
  prompt: AgentPrompt;
}) {
  const answeredBy = prompt.answeredBy ?? "";
  const profile = useUserProfileQuery(answeredBy);
  const name = resolveUserLabel({
    pubkey: answeredBy,
    currentPubkey,
    fallbackName: profile.data?.displayName,
    profiles,
  });

  return (
    <AgentPromptCardFrame state="answered">
      <p
        className="flex items-center gap-1.5 text-sm font-medium text-foreground"
        data-testid="agent-prompt-answered-by"
      >
        <CheckCircle2 aria-hidden className="size-4 text-primary" />
        {lostRace ? `Already answered by ${name}` : `Answered by ${name}`}
      </p>
      {lostRace ? (
        <p className="mt-0.5 text-xs text-muted-foreground">
          Your answer was not sent.
        </p>
      ) : null}
      <dl className="mt-2 flex flex-col gap-2">
        {prompt.questions.map((question) => {
          const labels = new Set(question.options.map((o) => o.label));
          return (
            <div key={question.id}>
              <dt className="text-xs text-muted-foreground">
                <span className="mr-1.5 rounded-md bg-muted px-1.5 py-0.5 font-medium text-foreground">
                  {question.header}
                </span>
                {question.question}
              </dt>
              <dd className="mt-1 text-sm text-foreground">
                {(prompt.answer?.[question.id] ?? []).map((choice) => (
                  <span className="block" key={choice}>
                    {labels.has(choice) ? choice : `Other: ${choice}`}
                  </span>
                ))}
              </dd>
            </div>
          );
        })}
      </dl>
    </AgentPromptCardFrame>
  );
}
