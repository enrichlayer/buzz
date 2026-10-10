import { PermissionCard } from "./PermissionCard";
import { parsePermissionRequest } from "./permissionContent";
import * as React from "react";
import { CircleHelp, CircleSlash } from "lucide-react";

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
    () => parseAgentPrompt(artifact.content, artifact.pubkey),
    [artifact.content, artifact.pubkey],
  );
  const identity = useIdentityQuery();
  const myPubkey = identity.data?.pubkey ?? currentPubkey;
  const [submit, setSubmit] = React.useState<SubmitState>({ status: "idle" });
  /** Set when our answer lost the race, so the winner's answer is explained. */
  const [lostRace, setLostRace] = React.useState(false);
  /** This viewer submitted, so the answered card should take focus. */
  const submittedRef = React.useRef(false);

  const handleSubmit = React.useCallback(
    async (answer: AgentPromptAnswer) => {
      if (!prompt || !myPubkey || prompt.state !== "open") return;
      const permission = parsePermissionRequest(prompt.raw.permission);
      if (permission && permission.ownerPubkey !== myPubkey) return;
      submittedRef.current = true;
      setSubmit({ status: "submitting" });
      try {
        await publishArtifactUpdate(
          artifact,
          buildAnsweredContent(prompt, answer, myPubkey),
        );
        setSubmit({ status: "idle" });
      } catch (error) {
        if (!isArtifactConflict(error)) {
          setSubmit({ status: "error", message: describeSubmitError(error) });
          return;
        }
        try {
          const head = await refreshArtifactHead(channelId, artifact.d);
          const latest = head
            ? parseAgentPrompt(head.content, head.pubkey)
            : null;
          setLostRace(latest?.state === "answered");
          setSubmit(
            latest?.state === "answered" || latest?.state === "cancelled"
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

  const permission = parsePermissionRequest(prompt.raw.permission);
  if (permission) {
    return (
      <PermissionCard
        channelId={channelId}
        parentEventId={artifact.root}
        prompt={prompt}
        permission={permission}
        currentPubkey={myPubkey}
        submitting={submit.status === "submitting"}
        errorMessage={submit.status === "error" ? submit.message : null}
        onSubmit={handleSubmit}
      />
    );
  }

  if (prompt.state === "cancelled") {
    return (
      <AgentPromptCardFrame state="cancelled">
        <p
          className="flex items-center gap-1.5 text-sm font-medium text-foreground"
          data-testid="agent-prompt-cancelled"
          role="status"
        >
          <CircleSlash aria-hidden className="size-4 text-muted-foreground" />
          Question cancelled
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{artifact.title}</p>
      </AgentPromptCardFrame>
    );
  }

  if (prompt.state === "answered") {
    return (
      <AgentPromptAnswered
        answeredBy={artifact.pubkey}
        currentPubkey={myPubkey}
        focusOnMount={submittedRef.current}
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

/** Relay rejection prefixes that mean "you may not write here". */
const PERMISSION_PREFIXES = ["restricted:", "blocked:", "auth-required:"];

function describeSubmitError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    PERMISSION_PREFIXES.some((prefix) => message.startsWith(prefix)) ||
    /permission/i.test(message)
  ) {
    return "You can't post in this channel, so you can't answer here.";
  }
  return message || "Could not send the answer. Try again.";
}
