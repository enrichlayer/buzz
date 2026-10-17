import * as React from "react";
import { ManualCommandResult } from "./ManualCommandResult";
import { ShieldCheck, Terminal } from "lucide-react";
import { invokeTauri } from "@/shared/api/tauri";
import { Button } from "@/shared/ui/button";
import type { AgentPrompt, AgentPromptAnswer } from "./agentPromptContent";
import { AgentPromptCardFrame } from "./AgentPromptCardFrame";
import type { PermissionRequest } from "./permissionContent";

/** Built-in permission specialization of the agent-prompt artifact plugin. */
export function PermissionCard({
  prompt,
  permission,
  currentPubkey,
  submitting,
  errorMessage,
  onSubmit,
  channelId,
  parentEventId,
}: {
  prompt: AgentPrompt;
  permission: PermissionRequest;
  currentPubkey?: string;
  submitting: boolean;
  errorMessage: string | null;
  onSubmit: (answer: AgentPromptAnswer) => Promise<void>;
  channelId: string;
  parentEventId: string | null;
}) {
  const [terminalStatus, setTerminalStatus] = React.useState<string | null>(
    null,
  );
  const [opening, setOpening] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const owner = currentPubkey === permission.ownerPubkey;
  const open = prompt.state === "open";
  const decision = prompt.answer?.permission?.[0];
  const toolTitle =
    typeof permission.toolCall.title === "string"
      ? permission.toolCall.title
      : "Agent tool action";
  const display =
    permission.command ?? JSON.stringify(permission.toolCall, null, 2);
  const openTerminal = async () => {
    setOpening(true);
    setTerminalStatus(null);
    try {
      const result = await invokeTauri<{ path: string }>(
        "open_agent_permission_terminal",
        {
          pubkey: permission.agentPubkey,
          cwd: permission.cwd,
          ownerPubkey: permission.ownerPubkey,
        },
      );
      setTerminalStatus(
        `Terminal opened at ${result.path}. No command was run.`,
      );
    } catch (error) {
      setTerminalStatus(
        error instanceof Error ? error.message : "Could not open the terminal.",
      );
    } finally {
      setOpening(false);
    }
  };
  return (
    <AgentPromptCardFrame
      state={prompt.state}
      data-testid="permission-card"
      className="space-y-4 p-4"
    >
      <h3 className="flex items-center gap-2 text-base font-semibold leading-6">
        <ShieldCheck aria-hidden className="size-5" />
        {open
          ? "Permission needed"
          : prompt.state === "cancelled"
            ? "Permission cancelled"
            : decision === "Allow once"
              ? "Approval sent"
              : "Denial sent"}
      </h3>
      {toolTitle !== display && (
        <p className="text-base leading-6">{toolTitle}</p>
      )}
      <pre
        className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-3 text-sm leading-6"
        data-testid="permission-command"
      >
        {display}
      </pre>
      <p className="break-all text-sm leading-6">
        <span className="font-medium">Working directory:</span> {permission.cwd}
      </p>
      {open ? (
        <>
          <p className="text-sm leading-6">
            {owner
              ? "Allow this action once, or deny it. Approval does not grant additional operating-system access."
              : "Waiting for the agent’s owner to decide."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!owner || submitting}
              onClick={() => void onSubmit({ permission: ["Deny"] })}
              variant="outline"
            >
              Deny
            </Button>
            <Button
              disabled={!owner || submitting}
              onClick={() => void onSubmit({ permission: ["Allow once"] })}
            >
              {submitting ? "Sending decision…" : "Allow once"}
            </Button>
          </div>
        </>
      ) : (
        <p role="status" className="text-sm leading-6">
          {prompt.state === "cancelled"
            ? "This request is no longer active."
            : `Decision by ${owner ? "you" : "the agent’s owner"}. Tool completion will appear separately in the transcript.`}
        </p>
      )}
      <details className="text-sm leading-6">
        <summary className="cursor-pointer">Handle this in a terminal</summary>
        <p className="mt-2">
          For manual execution, deny the pending request first to avoid running
          it twice. Open the terminal on the agent’s machine, review the
          command, then send the output and exit status back in this thread.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {permission.command ? (
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(permission.command ?? "");
                  setCopied(true);
                } catch {
                  setTerminalStatus(
                    "Could not copy. Select and copy the command above.",
                  );
                }
              }}
            >
              {copied ? "Copied" : "Copy command"}
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={!owner || opening}
            onClick={() => void openTerminal()}
          >
            <Terminal aria-hidden className="size-4" />
            {opening ? "Opening…" : "Open local terminal"}
          </Button>
        </div>
        <p className="mt-2 text-muted-foreground">
          Available only for agents managed locally on this device. Remote
          agents need a terminal on their own host.
        </p>
        {terminalStatus ? (
          <p role="status" className="mt-2 break-words">
            {terminalStatus}
          </p>
        ) : null}
        {owner &&
          !open &&
          decision !== "Allow once" &&
          permission.command &&
          parentEventId && (
            <ManualCommandResult
              channelId={channelId}
              parentEventId={parentEventId}
              agentPubkey={permission.agentPubkey}
              command={permission.command}
            />
          )}
      </details>
      {permission.command ? (
        <details className="text-sm leading-6">
          <summary className="cursor-pointer">Full tool request</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
            {JSON.stringify(permission.toolCall, null, 2)}
          </pre>
        </details>
      ) : null}
      {errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}
    </AgentPromptCardFrame>
  );
}
