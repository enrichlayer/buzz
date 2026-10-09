import * as React from "react";

export type RuntimePluginHost = {
  /** Place text in the current thread's composer. The host never sends it. */
  onCompose?: (text: string) => void;
};

const RuntimePluginHostContext = React.createContext<RuntimePluginHost>({});

export function RuntimePluginHostProvider({
  children,
  onCompose,
}: React.PropsWithChildren<RuntimePluginHost>) {
  const value = React.useMemo(() => ({ onCompose }), [onCompose]);
  return (
    <RuntimePluginHostContext.Provider value={value}>
      {children}
    </RuntimePluginHostContext.Provider>
  );
}

export function useRuntimePluginHost(): RuntimePluginHost {
  return React.useContext(RuntimePluginHostContext);
}
