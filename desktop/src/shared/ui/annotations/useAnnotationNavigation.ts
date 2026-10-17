import * as React from "react";
import { toast } from "sonner";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { AnnotationAnchor } from "./annotationModel";
import { AnnotationRegistryContext } from "./AnnotationWorkspace";
import {
  annotationRange,
  findAnnotationSource,
  focusAnnotationSource,
  waitForAnnotationSource,
} from "./annotationNavigation";

/** Navigate through the guarded message route, then highlight the verified selection. */
export function useAnnotationNavigation(anchor: AnnotationAnchor) {
  const registry = React.useContext(AnnotationRegistryContext);
  const { goChannel } = useAppNavigation();
  const [status, setStatus] = React.useState("");
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const report = (message: string) => {
    if (mounted.current) setStatus(message);
    else toast.info(message);
  };
  const open = async () => {
    const run = registry ? ++registry.navigationGeneration : 0;
    report("Opening source…");
    if (!registry) {
      report("Source navigation is unavailable.");
      return;
    }
    try {
      let entry = findAnnotationSource(registry, anchor);
      if (!entry) {
        if (
          typeof anchor.channelId !== "string" ||
          !anchor.channelId ||
          !/^[a-f0-9]{64}$/i.test(anchor.sourceId)
        ) {
          report("This source is not currently available in the conversation.");
          return;
        }
        await goChannel(anchor.channelId, { messageId: anchor.sourceId });
        entry = await waitForAnnotationSource(registry, anchor);
      }
      if (run !== registry.navigationGeneration) return;
      if (!entry) {
        report("Source is unavailable. Check channel access or try again.");
        return;
      }
      entry.root.scrollIntoView({ block: "center" });
      focusAnnotationSource(entry.root);
      const range = annotationRange(entry, anchor);
      if (typeof range === "string") {
        report(range);
        return;
      }
      if (
        typeof CSS === "undefined" ||
        !CSS.highlights ||
        typeof Highlight === "undefined"
      ) {
        report(
          "Source opened; selection highlighting is unsupported in this client.",
        );
        return;
      }
      const name = "annotation-source-selection";
      const highlight = new Highlight(range);
      CSS.highlights.set(name, highlight);
      // Lightning CSS does not yet recognize this standard pseudo-element.
      // Keep its rule scoped to the same bounded lifetime as the highlight.
      const style = document.createElement("style");
      style.textContent = `::highlight(${name}) { background-color: Highlight; color: HighlightText; }`;
      document.head.append(style);
      const clear = () => {
        style.remove();
        if (CSS.highlights.get(name) === highlight) CSS.highlights.delete(name);
      };
      const observer = new MutationObserver(() => {
        clear();
        observer.disconnect();
      });
      observer.observe(entry.root, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      window.setTimeout(() => {
        clear();
        observer.disconnect();
      }, 8000);
      report("Source opened and selection highlighted.");
    } catch {
      if (run === registry.navigationGeneration)
        report("Could not open this source. Try again.");
    }
  };
  return { open, status };
}
