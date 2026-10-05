import * as React from "react";
import { CircleHelp } from "lucide-react";

import { refreshArtifactHead } from "@/features/artifacts/channelArtifactSubscriptions";
import {
  isArtifactConflict,
  publishArtifactUpdate,
} from "@/features/artifacts/publishArtifactRevision";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { ArtifactTypeCardProps } from "@/shared/plugins/artifactTypes/cards";

import { AgentPromptAnswered } from "./AgentPromptAnswered";
import {
  type AgentPromptAnswer,
  buildAnsweredContent,
  parseAgentPrompt,
} from "./agentPromptContent";
import { AgentPromptCardFrame } from "./AgentPromptCardFrame";
import { QuestionForm } from "./QuestionForm";

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string };

/** Card for the `agent-prompt` artifact-type plugin (`buzz.agent_prompt`). */
export function AgentPromptCard({
  artifact,
  channelId,
  currentPubkey,
  profiles,
}: ArtifactTypeCardProps) {
  const prompt = React.useMemo(
    () => parseAgentPrompt(artifact.content),
    [artifact.content],
  );
  const identity = useIdentityQuery();
  const myPubkey = identity.data?.pubkey ?? currentPubkey;
  const [submit, setSubmit] = React.useState<SubmitState>({ status: "idle" });
  /** Set when our answer lost the race, so the winner's answer is explained. */
  const [lostRace, setLostRace] = React.useState(false);

  const handleSubmit = React.useCallback(
    async (answer: AgentPromptAnswer) => {
      if (!prompt || !myPubkey) return;
      setSubmit({ status: "submitting" });
      try {
        await publishArtifactUpdate(
          artifact,
          buildAnsweredContent(prompt, answer, myPubkey),
        );
        setSubmit({ status: "idle" });
      } catch (error) {
        if (!isArtifactConflict(error)) {
          setSubmit({
            status: "error",
            message:
              error instanceof Error ? error.message : "Could not send answer.",
          });
          return;
        }
        try {
          const head = await refreshArtifactHead(channelId, artifact.d);
          const latest = head ? parseAgentPrompt(head.content) : null;
          setLostRace(latest?.state === "answered");
          setSubmit(
            latest?.state === "answered"
              ? { status: "idle" }
              : {
                  status: "error",
                  message:
                    "This question changed while you were answering. Review it and submit again.",
                },
          );
        } catch {
          setSubmit({
            status: "error",
            message:
              "Someone else updated this question first, and loading their change failed. Try again.",
          });
        }
      }
    },
    [artifact, channelId, myPubkey, prompt],
  );

  if (!prompt) {
    return (
      <AgentPromptCardFrame state="fallback">
        <div className="flex items-center gap-2 text-sm">
          <CircleHelp aria-hidden className="size-4 text-muted-foreground" />
          <span className="font-medium text-foreground">{artifact.title}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          This question can't be shown in this version of Buzz.
        </p>
      </AgentPromptCardFrame>
    );
  }

  if (prompt.state === "answered") {
    return (
      <AgentPromptAnswered
        currentPubkey={myPubkey}
        lostRace={lostRace}
        profiles={profiles}
        prompt={prompt}
      />
    );
  }

  return (
    <QuestionForm
      canAnswer={Boolean(myPubkey)}
      errorMessage={submit.status === "error" ? submit.message : null}
      key={artifact.id}
      onSubmit={handleSubmit}
      prompt={prompt}
      submitting={submit.status === "submitting"}
    />
  );
}
