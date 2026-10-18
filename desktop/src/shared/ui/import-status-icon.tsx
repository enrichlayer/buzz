import { Check, X } from "lucide-react";

import { BuzzActivity } from "@el/buzz-ui";

export type ImportItemStatus = "pending" | "importing" | "done" | "error";

/**
 * Tiny status indicator used in sequential-import dialogs (persona batch
 * import, team import). Renders activity dots while importing, a check on
 * success, an X on failure, and nothing while pending.
 */
export function ImportStatusIcon({
  status,
}: {
  status: ImportItemStatus | undefined;
}) {
  switch (status) {
    case "importing":
      return (
        <BuzzActivity
          variant="inline"
          label="Importing"
          className="text-muted-foreground"
        />
      );
    case "done":
      return <Check className="h-4 w-4 shrink-0 text-green-500" />;
    case "error":
      return <X className="h-4 w-4 shrink-0 text-destructive" />;
    default:
      return null;
  }
}
