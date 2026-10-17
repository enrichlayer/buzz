import * as React from "react";
import { SegmentedControl } from "./segmented-control";

type Choice = { value: string; label: string; disabled?: boolean };

/** Keep the entire choice set visible only when every label fits its segment. */
export function AdaptiveSegmentedControl({
  ariaDescribedBy,
  disabled,
  fallback,
  id,
  legend,
  maxOptions = 3,
  onValueChange,
  options,
  testId = id,
  value,
}: {
  ariaDescribedBy?: string;
  disabled?: boolean;
  fallback: React.ReactNode;
  id: string;
  legend: string;
  maxOptions?: number;
  onValueChange: (value: string) => void;
  options: readonly Choice[];
  testId?: string;
  value: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const [fits, setFits] = React.useState(false);
  const restoreFocusRef = React.useRef(false);
  const eligible =
    options.length >= 2 &&
    options.length <= maxOptions &&
    new Set(options.map((option) => option.value)).size === options.length &&
    options.some((option) => option.value === value);
  const optionCount = options.length;
  // Callers pass inline option arrays; key the measurement on their content so
  // the observer is rebuilt only when the choices change.
  const optionsKey = JSON.stringify(
    options.map((option) => [option.value, option.label]),
  );
  const segmented = eligible && fits;

  // biome-ignore lint/correctness/useExhaustiveDependencies: optionsKey is intentional — the measured spans change with the labels even though the effect reads them from the DOM
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!eligible || !container || !measure) return;
    const update = () => {
      const widths = Array.from(
        measure.children,
        (child) => child.getBoundingClientRect().width,
      );
      // Measurement uses the same font and padding as the actual buttons;
      // the rail contributes another 0.25rem of padding.
      const railPadding =
        (Number.parseFloat(getComputedStyle(measure).paddingLeft) || 0) * 2;
      const needed = Math.max(...widths) * optionCount + railPadding;
      const nextFits =
        needed > railPadding && container.clientWidth >= Math.ceil(needed);
      if (
        nextFits !== Boolean(container.querySelector('[role="radiogroup"]')) &&
        container.contains(document.activeElement)
      ) {
        restoreFocusRef.current = true;
      }
      setFits(nextFits);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [eligible, optionCount, optionsKey]);

  React.useLayoutEffect(() => {
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const container = containerRef.current;
    const target =
      container?.querySelector<HTMLElement>(
        '[role="radio"][tabindex="0"]:not(:disabled)',
      ) ??
      container?.querySelector<HTMLElement>(
        "select:not(:disabled), button:not(:disabled)",
      );
    target?.focus();
  });

  // A radio group is not labelable, so a caller's <label htmlFor={id}> would do
  // nothing in segmented mode; route its click to the group's tab stop.
  React.useEffect(() => {
    const doc = containerRef.current?.ownerDocument;
    if (!segmented || !doc) return;
    const handleClick = (event: MouseEvent) => {
      const label =
        event.target instanceof Element ? event.target.closest("label") : null;
      if (!label || label.htmlFor !== id) return;
      containerRef.current
        ?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')
        ?.focus();
    };
    doc.addEventListener("click", handleClick);
    return () => doc.removeEventListener("click", handleClick);
  }, [id, segmented]);

  return (
    <div className="relative min-w-0 w-full" ref={containerRef}>
      {eligible ? (
        <div
          aria-hidden="true"
          className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
        >
          <div
            className="flex w-max gap-0 p-0.5 text-xs font-medium"
            ref={measureRef}
          >
            {options.map((option) => (
              <span className="whitespace-pre px-2.5" key={option.value}>
                {option.label}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {segmented ? (
        <SegmentedControl
          ariaDescribedBy={ariaDescribedBy}
          className="h-9 w-full [&_button]:whitespace-pre"
          disabled={disabled}
          id={id}
          legend={legend}
          onValueChange={onValueChange}
          optionTestIdPrefix={`${testId}-option`}
          options={options}
          testId={testId}
          value={value}
        />
      ) : (
        fallback
      )}
    </div>
  );
}
