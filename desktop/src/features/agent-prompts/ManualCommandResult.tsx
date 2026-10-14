import * as React from "react";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useSendMessageMutation } from "@/features/messages/hooks";
import { Button } from "@/shared/ui/button";

export function ManualCommandResult({
  channelId,
  parentEventId,
  agentPubkey,
  command,
}: {
  channelId: string;
  parentEventId: string;
  agentPubkey: string;
  command: string;
}) {
  const identity = useIdentityQuery();
  const send = useSendMessageMutation(null, identity.data);
  const [output, setOutput] = React.useState("");
  const [executedCommand, setExecutedCommand] = React.useState(command);
  const [exitCode, setExitCode] = React.useState("");
  const validExit = /^\d{1,3}$/.test(exitCode) && Number(exitCode) <= 255;
  const validContent =
    executedCommand.trim().length > 0 &&
    new TextEncoder().encode(executedCommand).length <= 4000 &&
    new TextEncoder().encode(output).length <= 16000;
  const submit = async () => {
    if (!validExit || !validContent || send.isPending || send.isSuccess) return;
    const commandPreview = executedCommand.slice(0, 4000);
    const longest = (marker: string) =>
      Math.max(
        0,
        ...[commandPreview, output].flatMap((s) =>
          s.split(new RegExp(`[^${marker}]`)).map((run) => run.length),
        ),
      );
    const ticks = longest("`");
    const tildes = longest("~");
    const fence = (ticks <= tildes ? "`" : "~").repeat(
      Math.max(3, Math.min(ticks, tildes) + 1),
    );
    await send
      .mutateAsync({
        channelId,
        parentEventId,
        mentionPubkeys: [agentPubkey],
        forceRest: true,
        content: `Human-reported terminal result · exit ${Number(exitCode)}\n\nI ran this command manually. This output is supplied by me, not independently verified by Buzz.${executedCommand !== command ? " I changed the command from the original permission request." : ""}\n\n${fence}bash\n${commandPreview}\n${fence}\n\n${fence}text\n${output || "(no output)"}\n${fence}\n\nUse this result to continue; do not rerun the command automatically.`,
      })
      .catch(() => {}); // The mutation error remains visible beside the form.
  };
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <p className="font-medium">Return your terminal result</p>
      <label className="block">
        Command you ran
        <textarea
          aria-label="Manual command executed"
          className="mt-1 min-h-20 w-full rounded-md border border-border bg-background p-3 font-mono text-sm leading-6"
          maxLength={4000}
          value={executedCommand}
          onChange={(e) => setExecutedCommand(e.target.value)}
          disabled={send.isPending || send.isSuccess}
        />
      </label>
      <label className="block">
        Output
        <textarea
          aria-label="Manual command output"
          className="mt-1 min-h-28 w-full rounded-md border border-border bg-background p-3 font-mono text-sm leading-6"
          maxLength={16000}
          value={output}
          onChange={(e) => setOutput(e.target.value)}
          disabled={send.isPending || send.isSuccess}
        />
      </label>
      <label className="block">
        Exit status
        <input
          aria-label="Manual command exit status"
          inputMode="numeric"
          placeholder="0"
          className="ml-3 w-20 rounded-md border border-border bg-background px-3 py-2"
          value={exitCode}
          onChange={(e) => setExitCode(e.target.value)}
          disabled={send.isPending || send.isSuccess}
        />
      </label>
      <p className="text-muted-foreground">
        Review for secrets before sharing. This posts as you and asks the agent
        to continue.
      </p>
      {!validContent && (executedCommand || output) && (
        <p role="alert">
          Enter a command up to 4,000 bytes and output up to 16,000 bytes.
        </p>
      )}
      <Button
        disabled={
          !validExit || !validContent || send.isPending || send.isSuccess
        }
        onClick={() => void submit()}
      >
        {send.isSuccess
          ? "Result shared"
          : send.isPending
            ? "Sharing…"
            : "Share result with agent"}
      </Button>
      {send.error && (
        <p role="alert" className="text-destructive">
          {send.error.message}
        </p>
      )}
    </div>
  );
}
