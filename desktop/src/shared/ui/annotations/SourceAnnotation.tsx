import * as React from "react";
import { cn } from "@/shared/lib/cn";
import type {
  AnnotationSource,
  AnnotationSubmitRequest,
} from "./annotationModel";
import type { AnnotationScope } from "./annotationRegistry";
import {
  AnnotationRegistryContext,
  AnnotationWorkspace,
} from "./AnnotationWorkspace";

export { AnnotationWorkspace } from "./AnnotationWorkspace";

export function AnnotationSubmitProvider(props: {
  children: React.ReactNode;
  onSubmit: (request: AnnotationSubmitRequest) => Promise<void>;
  scope?: AnnotationScope;
}) {
  const registry = React.useContext(AnnotationRegistryContext);
  return registry ? (
    <RegisteredScope {...props} />
  ) : (
    <AnnotationWorkspace>
      <RegisteredScope {...props} />
    </AnnotationWorkspace>
  );
}

function RegisteredScope({
  children,
  onSubmit,
  scope,
}: {
  children: React.ReactNode;
  onSubmit: (request: AnnotationSubmitRequest) => Promise<void>;
  scope?: AnnotationScope;
}) {
  const registry = React.useContext(AnnotationRegistryContext);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const generatedId = React.useId();
  const current = React.useRef({ onSubmit, scope });
  current.current = { onSubmit, scope };
  const scopeId = scope?.id ?? generatedId;
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!registry || !root) return;
    const entry = {
      root,
      get scope() {
        return (
          current.current.scope ?? { id: scopeId, label: "this conversation" }
        );
      },
      submit: (request: AnnotationSubmitRequest) =>
        current.current.onSubmit(request),
    };
    registry.scopes.add(entry);
    return () => {
      registry.scopes.delete(entry);
      if (registry.activeScope === entry) registry.activeScope = null;
      registry.changed(root);
    };
  }, [registry, scopeId]);
  return (
    <div className="contents" data-annotation-scope={scopeId} ref={rootRef}>
      {children}
    </div>
  );
}

/** Optional provenance: selection also works on content without this wrapper. */
export function SourceAnnotation({
  children,
  className,
  source,
}: {
  children: React.ReactNode;
  className?: string;
  source: AnnotationSource;
}) {
  const registry = React.useContext(AnnotationRegistryContext);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const currentSource = React.useRef(source);
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!registry || !root) return;
    registry.sources.set(root, { root, read: () => currentSource.current });
    return () => {
      registry.sources.delete(root);
      registry.changed(root);
    };
  }, [registry]);
  React.useLayoutEffect(() => {
    currentSource.current = source;
    if (rootRef.current) registry?.changed(rootRef.current);
  }, [registry, source]);
  return (
    <div
      className={cn("group/annotation relative", className)}
      data-annotation-source-id={source.sourceId}
      ref={rootRef}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}
