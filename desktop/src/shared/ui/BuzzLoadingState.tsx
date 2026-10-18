import { cn } from "@/shared/lib/cn";
import { BuzzActivity } from "@el/buzz-ui";

/** Centered, low-emphasis loading state for page and panel fetches. */
export function BuzzLoadingState({
  className,
  fill = false,
  label = "Loading",
}: {
  className?: string;
  fill?: boolean;
  label?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center justify-center text-primary",
        fill ? "min-h-0 flex-1" : "min-h-[calc(100dvh-7rem)]",
        className,
      )}
      data-testid="buzz-loading-state"
    >
      <BuzzActivity label={label} />
    </div>
  );
}
