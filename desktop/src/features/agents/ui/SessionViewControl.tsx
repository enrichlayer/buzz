import type { SessionView } from "./threadSessionPresentation";
import { SegmentedControl } from "@/shared/ui/segmented-control";

const VIEW_OPTIONS = [
  { value: "conversation", label: "Conversation" },
  { value: "activity", label: "Activity" },
  { value: "full", label: "Full transcript" },
] as const;

/** Local reader controls independent of the agent's configured output policy. */
export function SessionViewControl({
  value,
  onChange,
}: {
  value: SessionView;
  onChange: (value: SessionView) => void;
}) {
  return (
    <SegmentedControl
      className="h-auto min-h-8 w-full max-w-sm [&_button]:px-2 [&_button]:py-1.5"
      legend="Transcript view"
      onValueChange={onChange}
      optionTestIdPrefix="session-view"
      options={VIEW_OPTIONS}
      testId="session-view-control"
      value={value}
    />
  );
}
