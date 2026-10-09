import { isTauri } from "@tauri-apps/api/core";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/app/App";
import { RootErrorBoundary } from "@/app/RootErrorBoundary";
import { NostrBindConsentDialog } from "@/features/profile/ui/NostrBindConsentDialog";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@/shared/styles/globals.css";
import { UpdaterProvider } from "@/features/settings/hooks/UpdaterProvider";
import { migrateLegacyCommunityStorageBeforeRender } from "@/features/communities/legacyCommunityStorage";
import { CommunitiesProvider } from "@/features/communities/useCommunities";
import { huddleWindowChannelId } from "@/features/huddle/lib/huddleWindow";
import { CommunityOnboardingProvider } from "@/features/onboarding/communityOnboarding";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { AvatarClipPaths } from "@/shared/ui/AvatarClipPaths";
import { EmojiBurstProvider } from "@/shared/ui/EmojiBurstProvider";
import { PoofBurstProvider } from "@/shared/ui/PoofBurstProvider";
import { Toaster } from "@/shared/ui/sonner";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { recoverLocalStorageQuotaOnStartup } from "@/shared/lib/localStorageQuota";
import { startLocalStorageSweep } from "@/shared/lib/localStorageSweep";
import { initializeConversationDensityPreference } from "@/shared/lib/conversationDensityPreference";
import { initializeFontSizePreference } from "@/shared/lib/fontSizePreference";

type E2eWindow = Window & {
  __BUZZ_E2E__?: unknown;
};

const E2E_DEFAULT_PUBKEY = "deadbeef".repeat(8);
const E2E_COMMUNITY_ID = "e2e-default-community";
const ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX = "buzz-onboarding-complete.v1:";
const DEV_STATE_RESET_PARAM = "resetDevState";

function resetDevWebviewStateFromUrl() {
  if (!import.meta.env.DEV) {
    return;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.get(DEV_STATE_RESET_PARAM) !== "1") {
    return;
  }

  // WebKit groups every Buzz binary under one disk directory, but storage is
  // isolated by origin. Clearing here resets only this dev server's origin;
  // deleting the shared WebKit directory would also destroy installed-app state.
  window.localStorage.clear();
  window.sessionStorage.clear();
  url.searchParams.delete(DEV_STATE_RESET_PARAM);
  window.history.replaceState(window.history.state, "", url);
}

function configureDevE2eBridgeFromUrl() {
  if (!import.meta.env.DEV) {
    return;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.get("e2e") !== "mock") {
    return;
  }

  const e2eWindow = window as E2eWindow;
  e2eWindow.__BUZZ_E2E__ ??= { mode: "mock" };

  const community = {
    addedAt: new Date().toISOString(),
    id: E2E_COMMUNITY_ID,
    name: "E2E Test",
    relayUrl: "ws://localhost:3000",
  };
  window.localStorage.setItem("buzz-communities", JSON.stringify([community]));
  window.localStorage.setItem("buzz-active-community-id", E2E_COMMUNITY_ID);
  window.localStorage.setItem(
    `${ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX}${E2E_DEFAULT_PUBKEY}`,
    "true",
  );
}

let PreviewNotice: React.ComponentType | null = null;

function renderApp() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {/* block/buzz#5078 — catch any uncaught render error so a WebKit
          SecurityError from localStorage can't blank the whole window. */}
      <RootErrorBoundary>
        {PreviewNotice ? <PreviewNotice /> : null}
        <AvatarClipPaths />
        <CommunitiesProvider>
          <CommunityOnboardingProvider
            enabled={huddleWindowChannelId() === null}
          >
            <ThemeProvider defaultTheme="buzz">
              <TooltipProvider>
                <EmojiBurstProvider>
                  <PoofBurstProvider>
                    <UpdaterProvider>
                      <App />
                      <NostrBindConsentDialog />
                    </UpdaterProvider>
                    <Toaster />
                  </PoofBurstProvider>
                </EmojiBurstProvider>
              </TooltipProvider>
            </ThemeProvider>
          </CommunityOnboardingProvider>
        </CommunitiesProvider>
      </RootErrorBoundary>
    </React.StrictMode>,
  );
}

async function installE2eBridgeIfConfigured() {
  // The mock bridge is compiled only into dev and explicit E2E builds. A
  // pre-bootstrap global alone must never activate mock IPC in production.
  if (
    !(import.meta.env.DEV || import.meta.env.MODE === "e2e") ||
    !(window as E2eWindow).__BUZZ_E2E__
  ) {
    return;
  }

  const { maybeInstallE2eTauriMocks } = await import("@/testing/e2eBridge");
  maybeInstallE2eTauriMocks();
}

async function bootstrap() {
  // A desktop frontend cannot use native IPC in an ordinary browser. Offer an
  // explicit fixture preview instead of failing later in community startup.
  const devBrowser = import.meta.env.DEV && !isTauri();
  const preview =
    devBrowser &&
    (new URL(location.href).searchParams.get("preview") === "coding" ||
      sessionStorage.getItem("buzz-coding-preview") === "1");
  if (
    devBrowser &&
    !preview &&
    !(window as E2eWindow).__BUZZ_E2E__ &&
    new URL(location.href).searchParams.get("e2e") !== "mock"
  ) {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <main className="mx-auto max-w-xl space-y-4 p-8">
        <h1 className="text-xl font-semibold">Buzz browser preview</h1>
        <p>
          The desktop app uses native services for your community, identity and
          local agents. This browser can test the interface with sample data.
        </p>
        <a
          className="inline-block rounded border px-4 py-2 underline"
          href="?e2e=mock&preview=coding"
        >
          Open coding session preview
        </a>
        <p className="text-sm">
          Use Buzz Dev for live communities and real agent sessions.
        </p>
      </main>,
    );
    return;
  }
  resetDevWebviewStateFromUrl();
  configureDevE2eBridgeFromUrl();
  recoverLocalStorageQuotaOnStartup();
  initializeConversationDensityPreference();
  initializeFontSizePreference();
  startLocalStorageSweep();
  if (preview) {
    const { configureCodingPreview } = await import("@/testing/codingPreview");
    configureCodingPreview();
    sessionStorage.setItem("buzz-coding-preview", "1");
    // Hash history appends location.search; consume bootstrap parameters first.
    history.replaceState(history.state, "", location.pathname);
    PreviewNotice = (await import("@/testing/BrowserPreviewNotice"))
      .BrowserPreviewNotice;
  }
  await installE2eBridgeIfConfigured();
  await migrateLegacyCommunityStorageBeforeRender();
  renderApp();
}

void bootstrap();
