import { loadCodingPreview, loadPermissionPreview } from "./codingPreview";

export function BrowserPreviewNotice() {
  return (
    <aside
      className="fixed bottom-2 left-2 z-[100] flex max-w-[calc(100vw-1rem)] flex-wrap items-center gap-3 rounded-md border border-border bg-background p-2 text-xs text-foreground shadow-md"
      aria-label="Browser preview"
    >
      <span>Browser preview · sample data · no live agent</span>
      <button
        type="button"
        className="shrink-0 rounded border border-border px-2 py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        onClick={loadCodingPreview}
      >
        Load coding session
      </button>
      <button
        type="button"
        className="shrink-0 rounded border border-border px-2 py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        onClick={loadPermissionPreview}
      >
        Load permission card
      </button>
    </aside>
  );
}
