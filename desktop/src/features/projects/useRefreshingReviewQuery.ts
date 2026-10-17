import { useQuery, type UseQueryOptions } from "@tanstack/react-query";

import { useFocusedRefetchInterval } from "@/shared/lib/useDocumentVisible";

/** Keep an open review current with other users while the app is focused. */
export function useRefreshingReviewQuery<T>(options: UseQueryOptions<T>) {
  const refetchInterval = useFocusedRefetchInterval(5_000);
  return useQuery({ ...options, refetchInterval });
}
