export type RuntimeValue =
  | string
  | {
      path: string;
      fallback?: string;
    };

export type RuntimePluginAction = {
  kind: "copy" | "compose";
  label: string;
  template: string;
};

export type RuntimePluginField = {
  id: string;
  label: string;
  type: "text" | "textarea" | "select" | "checkbox";
  initial?: RuntimeValue;
  options?: string[];
  /** Omitted or dropdown preserves the original select presentation. */
  presentation?: "dropdown" | "segmented";
  placeholder?: string;
  required?: boolean;
};

export type RuntimePluginBlock =
  | { type: "heading"; text: RuntimeValue; level?: 2 | 3 | 4 }
  | { type: "text"; text: RuntimeValue }
  | { type: "code"; value: RuntimeValue; language?: string }
  | { type: "diff"; value: RuntimeValue; filename?: RuntimeValue }
  | {
      type: "accordion";
      title: RuntimeValue;
      children: RuntimePluginBlock[];
    }
  | { type: "action"; action: RuntimePluginAction }
  | {
      type: "form";
      id: string;
      title?: RuntimeValue;
      fields: RuntimePluginField[];
      submit: RuntimePluginAction;
    };

export type RuntimePluginManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  fenceLanguage: string;
  contentType: "json" | "text";
  blocks: RuntimePluginBlock[];
};

export type InstalledRuntimePlugin = {
  enabled: boolean;
  manifest: RuntimePluginManifest;
};

export type RuntimePluginSnapshot = {
  schemaVersion: 1;
  plugins: InstalledRuntimePlugin[];
};

export type RuntimePluginStoreState = {
  loadError: string | null;
  persistenceError: string | null;
  plugins: InstalledRuntimePlugin[];
};
