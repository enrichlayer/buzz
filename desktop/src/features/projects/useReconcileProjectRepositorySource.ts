import * as React from "react";

/** Reconcile repository source only after checkout discovery is authoritative. */
export function useReconcileProjectRepositorySource({
  hasLocalCheckout,
  localCheckoutPending,
  remoteHasContent,
  selectedPullRequestId,
  selectedTag,
  setSource,
  source,
}: {
  hasLocalCheckout: boolean;
  localCheckoutPending: boolean;
  remoteHasContent: boolean;
  selectedPullRequestId: string | null;
  selectedTag: string | null;
  setSource: React.Dispatch<React.SetStateAction<"remote" | "local">>;
  source: "remote" | "local";
}) {
  React.useEffect(() => {
    if (selectedTag) {
      if (source !== "remote") setSource("remote");
      return;
    }
    if (source === "local" && !hasLocalCheckout) {
      // Changing branches creates new query keys. Their initial lack of data
      // is not evidence that the checkout disappeared.
      if (!localCheckoutPending) setSource("remote");
      return;
    }
    if (
      !selectedPullRequestId &&
      source === "remote" &&
      !remoteHasContent &&
      hasLocalCheckout
    ) {
      setSource("local");
    }
  }, [
    hasLocalCheckout,
    localCheckoutPending,
    remoteHasContent,
    selectedPullRequestId,
    selectedTag,
    setSource,
    source,
  ]);
}
