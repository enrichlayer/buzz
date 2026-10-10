import * as React from "react";
import { parseRuntimePluginManifest } from "./schema";
import type {
  InstalledRuntimePlugin,
  RuntimePluginManifest,
  RuntimePluginSnapshot,
  RuntimePluginStoreState,
} from "./types";

export const RUNTIME_PLUGIN_STORAGE_KEY = "buzz.runtime-plugins.v1";
export const MAX_RUNTIME_PLUGINS = 32;

const listeners = new Set<() => void>();
let loaded = false;
let listeningForStorageChanges = false;
let fallbackMutationQueue = Promise.resolve();
let state: RuntimePluginStoreState = {
  loadError: null,
  persistenceError: null,
  plugins: [],
};

function emit(next: RuntimePluginStoreState): void {
  state = next;
  for (const listener of listeners) listener();
}

function readSnapshot(): RuntimePluginStoreState {
  try {
    const raw = globalThis.localStorage?.getItem(RUNTIME_PLUGIN_STORAGE_KEY);
    if (!raw) return { loadError: null, persistenceError: null, plugins: [] };
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Array.isArray((parsed as { plugins?: unknown }).plugins)
    ) {
      throw new Error("saved snapshot has an unsupported shape");
    }
    const entries = (parsed as RuntimePluginSnapshot).plugins;
    if (entries.length > MAX_RUNTIME_PLUGINS) {
      throw new Error(`saved snapshot exceeds ${MAX_RUNTIME_PLUGINS} plugins`);
    }
    const plugins = entries.map((entry, index) => {
      if (!entry || typeof entry.enabled !== "boolean") {
        throw new Error(`saved plugin ${index + 1} has invalid state`);
      }
      const result = parseRuntimePluginManifest(JSON.stringify(entry.manifest));
      if (!result.ok) {
        throw new Error(`saved plugin ${index + 1}: ${result.error}`);
      }
      return { enabled: entry.enabled, manifest: result.manifest };
    });
    const ids = new Set(plugins.map((entry) => entry.manifest.id));
    const languages = new Set(
      plugins.map((entry) => entry.manifest.fenceLanguage),
    );
    if (ids.size !== plugins.length || languages.size !== plugins.length) {
      throw new Error(
        "saved snapshot contains duplicate ids or fence languages",
      );
    }
    return { loadError: null, persistenceError: null, plugins };
  } catch (error) {
    return {
      loadError: `Could not load saved plugins: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      persistenceError: null,
      plugins: [],
    };
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  state = readSnapshot();
  if (!listeningForStorageChanges && globalThis.window?.addEventListener) {
    globalThis.window.addEventListener("storage", (event) => {
      if (event.key === RUNTIME_PLUGIN_STORAGE_KEY || event.key === null) {
        emit(readSnapshot());
      }
    });
    listeningForStorageChanges = true;
  }
}

function persist(
  plugins: InstalledRuntimePlugin[],
  durableState: RuntimePluginStoreState,
): boolean {
  const snapshot: RuntimePluginSnapshot = { schemaVersion: 1, plugins };
  try {
    if (!globalThis.localStorage) throw new Error("localStorage unavailable");
    globalThis.localStorage.setItem(
      RUNTIME_PLUGIN_STORAGE_KEY,
      JSON.stringify(snapshot),
    );
    emit({ loadError: null, persistenceError: null, plugins });
    return true;
  } catch (error) {
    emit({
      ...durableState,
      persistenceError: `Could not save plugins: ${
        error instanceof Error ? error.message : "storage unavailable"
      }`,
    });
    return false;
  }
}

function conflictFor(
  plugins: InstalledRuntimePlugin[],
  manifest: RuntimePluginManifest,
  excludingId?: string,
): string | null {
  const languageOwner = plugins.find(
    (entry) =>
      entry.manifest.id !== excludingId &&
      entry.manifest.fenceLanguage === manifest.fenceLanguage,
  );
  return languageOwner
    ? `Fence language ${manifest.fenceLanguage} is already owned by ${languageOwner.manifest.id}`
    : null;
}

async function withMutationLock<T>(operation: () => T): Promise<T> {
  const lockManager = globalThis.navigator?.locks;
  if (lockManager) {
    return lockManager.request(RUNTIME_PLUGIN_STORAGE_KEY, operation);
  }
  // Native Buzz exposes plugin mutation only from main-window Settings; the
  // companion window is read-only. This queue serializes that one writer when
  // Web Locks are unavailable. Any future second mutating surface must require
  // a cross-realm lock (or refuse mutation) rather than relying on this queue.
  const queued = fallbackMutationQueue.then(operation, operation);
  fallbackMutationQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

function normalizeManifest(
  manifest: RuntimePluginManifest,
):
  | { ok: true; manifest: RuntimePluginManifest }
  | { ok: false; error: string } {
  try {
    return parseRuntimePluginManifest(JSON.stringify(manifest));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid manifest",
    };
  }
}

export function getRuntimePluginState(): RuntimePluginStoreState {
  ensureLoaded();
  return state;
}

export function subscribeRuntimePlugins(listener: () => void): () => void {
  ensureLoaded();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRuntimePluginState(): RuntimePluginStoreState {
  return React.useSyncExternalStore(
    subscribeRuntimePlugins,
    getRuntimePluginState,
    getRuntimePluginState,
  );
}

export function useRuntimeCodeFencePlugin(
  language: string,
): RuntimePluginManifest | undefined {
  const snapshot = useRuntimePluginState();
  return snapshot.plugins.find(
    (entry) => entry.enabled && entry.manifest.fenceLanguage === language,
  )?.manifest;
}

export function getRuntimeCodeFencePlugin(
  language: string,
): RuntimePluginManifest | undefined {
  ensureLoaded();
  return state.plugins.find(
    (entry) => entry.enabled && entry.manifest.fenceLanguage === language,
  )?.manifest;
}

export async function installRuntimePlugin(
  manifest: RuntimePluginManifest,
): Promise<{ ok: true } | { ok: false; error: string }> {
  ensureLoaded();
  const parsed = normalizeManifest(manifest);
  if (!parsed.ok) return parsed;
  const normalized = parsed.manifest;
  return withMutationLock(() => {
    const durable = readSnapshot();
    if (durable.loadError) {
      emit(durable);
      return {
        ok: false as const,
        error: "Clear corrupted plugin data before installing",
      };
    }
    if (durable.plugins.some((entry) => entry.manifest.id === normalized.id)) {
      return {
        ok: false as const,
        error: `${normalized.id} is already installed; use Update`,
      };
    }
    if (durable.plugins.length >= MAX_RUNTIME_PLUGINS) {
      return {
        ok: false as const,
        error: `At most ${MAX_RUNTIME_PLUGINS} plugins may be installed`,
      };
    }
    const conflict = conflictFor(durable.plugins, normalized);
    if (conflict) return { ok: false as const, error: conflict };
    return persist(
      [...durable.plugins, { enabled: true, manifest: normalized }],
      durable,
    )
      ? { ok: true as const }
      : {
          ok: false as const,
          error: "Plugin was not installed because persistence failed",
        };
  });
}

export async function updateRuntimePlugin(
  manifest: RuntimePluginManifest,
): Promise<{ ok: true } | { ok: false; error: string }> {
  ensureLoaded();
  const parsed = normalizeManifest(manifest);
  if (!parsed.ok) return parsed;
  const normalized = parsed.manifest;
  return withMutationLock(() => {
    const durable = readSnapshot();
    if (durable.loadError) {
      emit(durable);
      return {
        ok: false as const,
        error: "Clear corrupted plugin data before updating",
      };
    }
    const index = durable.plugins.findIndex(
      (entry) => entry.manifest.id === normalized.id,
    );
    if (index < 0)
      return {
        ok: false as const,
        error: `${normalized.id} is not installed`,
      };
    const conflict = conflictFor(durable.plugins, normalized, normalized.id);
    if (conflict) return { ok: false as const, error: conflict };
    const plugins = durable.plugins.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, manifest: normalized } : entry,
    );
    return persist(plugins, durable)
      ? { ok: true as const }
      : {
          ok: false as const,
          error: "Plugin was not updated because persistence failed",
        };
  });
}

export async function setRuntimePluginEnabled(
  id: string,
  enabled: boolean,
): Promise<boolean> {
  ensureLoaded();
  return withMutationLock(() => {
    const durable = readSnapshot();
    if (durable.loadError) {
      emit(durable);
      return false;
    }
    if (!durable.plugins.some((entry) => entry.manifest.id === id))
      return false;
    return persist(
      durable.plugins.map((entry) =>
        entry.manifest.id === id ? { ...entry, enabled } : entry,
      ),
      durable,
    );
  });
}

export async function removeRuntimePlugin(id: string): Promise<boolean> {
  ensureLoaded();
  return withMutationLock(() => {
    const durable = readSnapshot();
    if (durable.loadError) {
      emit(durable);
      return false;
    }
    if (!durable.plugins.some((entry) => entry.manifest.id === id))
      return false;
    return persist(
      durable.plugins.filter((entry) => entry.manifest.id !== id),
      durable,
    );
  });
}

export async function clearRuntimePluginStorage(): Promise<boolean> {
  ensureLoaded();
  return withMutationLock(() => {
    try {
      if (!globalThis.localStorage) throw new Error("localStorage unavailable");
      globalThis.localStorage.removeItem(RUNTIME_PLUGIN_STORAGE_KEY);
      emit({ loadError: null, persistenceError: null, plugins: [] });
      return true;
    } catch (error) {
      emit({
        ...state,
        persistenceError: `Could not clear saved plugins: ${
          error instanceof Error ? error.message : "storage unavailable"
        }`,
      });
      return false;
    }
  });
}

/** Reset module state so focused unit tests can replace localStorage. */
export function __resetRuntimePluginStoreForTests(): void {
  loaded = false;
  state = { loadError: null, persistenceError: null, plugins: [] };
  fallbackMutationQueue = Promise.resolve();
  listeners.clear();
}
