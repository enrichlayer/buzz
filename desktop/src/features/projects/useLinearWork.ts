import { useQuery } from "@tanstack/react-query";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import { relayClient } from "@/shared/api/relayClient";
import { getRelayWsUrl } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { fetchLinearWork } from "./linearWorkFetch";

/** Private projections are cached only within the current community and signer. */
export function useLinearWork(enabled = true) {
  const { activeCommunity } = useCommunities();
  const identity = useIdentityQuery();
  const relay = activeCommunity?.relayUrl;
  const signer = identity.data?.pubkey;
  return useQuery({
    queryKey: ["linear-work", relay, signer],
    enabled: enabled && Boolean(relay && signer),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async ({ signal }) => {
      const assertScope = async () => {
        signal.throwIfAborted();
        const [currentRelay, currentIdentity] = await Promise.all([
          getRelayWsUrl(),
          getIdentity(),
        ]);
        if (
          !relay ||
          new URL(currentRelay).origin !== new URL(relay).origin ||
          currentIdentity.pubkey !== signer
        )
          throw new Error(
            "Community or identity changed while loading private Linear work.",
          );
        signal.throwIfAborted();
      };
      return fetchLinearWork(async (filter) => {
        await assertScope();
        const events = await relayClient.fetchEvents(filter);
        await assertScope();
        return events;
      }, signal);
    },
  });
}
