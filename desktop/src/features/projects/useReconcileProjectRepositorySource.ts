import * as React from "react";

/** Reconcile repository source only after checkout discovery is authoritative. */
export function useReconcileProjectRepositorySource({
  checkoutQueries,
  hasLocalCheckout,
  remoteHasContent,
  selectedPullRequestId,
  selectedTag,
  setSource,
  source,
}: {
  checkoutQueries: ReadonlyArray<{ isEnabled: boolean; isPending: boolean }>;
  hasLocalCheckout: boolean;
  remoteHasContent: boolean;
  selectedPullRequestId: string | null;
  selectedTag: string | null;
  setSource: React.Dispatch<React.SetStateAction<"remote" | "local">>;
  source: "remote" | "local";
}) {
  // Disabled queries remain pending without fetching (for example, remote
  // sync is Buzz-only). They cannot keep a missing external checkout selected.
  const localCheckoutPending = checkoutQueries.some(
    (query) => query.isEnabled && query.isPending,
  );
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
