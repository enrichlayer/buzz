import * as React from "react";

import { cn } from "@/shared/lib/cn";

type SegmentOption<Value extends string> = {
  value: Value;
  label: string;
  disabled?: boolean;
  Icon?: React.ComponentType<{ className?: string }>;
};

type SegmentedControlSize = "compact" | "default" | "wide";

const SIZE_CLASSES: Record<SegmentedControlSize, string> = {
  compact: "w-48",
  default: "w-60",
  wide: "w-72",
};

/** A mutually exclusive control with equal-width, optionally scrubbable options. */
export function SegmentedControl<Value extends string>({
  ariaDescribedBy,
  className,
  disabled = false,
  indicatorTestId,
  id,
  legend,
  onPreviewChange,
  onValueChange,
  optionTestIdPrefix,
  options,
  size = "default",
  testId,
  value,
}: {
  ariaDescribedBy?: string;
  className?: string;
  disabled?: boolean;
  indicatorTestId?: string;
  id?: string;
  legend: string;
  onPreviewChange?: (value: Value | null) => void;
  onValueChange: (value: Value) => void;
  optionTestIdPrefix: string;
  options: readonly SegmentOption<Value>[];
  size?: SegmentedControlSize;
  testId: string;
  value: Value;
}) {
  const [previewValue, setPreviewValue] = React.useState<Value | null>(null);
  const controlRef = React.useRef<HTMLDivElement | null>(null);
  const activePointerIdRef = React.useRef<number | null>(null);
  const pointerStartXRef = React.useRef<number | null>(null);
  const pointerStartValueRef = React.useRef<Value | null>(null);
  const scrubValueRef = React.useRef<Value | null>(null);
  const skipPointerClickRef = React.useRef(false);
  const displayedValue = previewValue ?? value;
  const selectedIndex = options.findIndex(
    (option) => option.value === displayedValue,
  );
  // Radio groups expose one tab stop: the checked option, or the first
  // enabled one when the checked option is unavailable.
  const tabStopValue =
    options.find((option) => option.value === value && !option.disabled)
      ?.value ?? options.find((option) => !option.disabled)?.value;

  /** The enabled option under the pointer, or null over a disabled one. */
  const getValueAtPointer = React.useCallback(
    (element: HTMLDivElement, clientX: number): Value | null => {
      const bounds = element.getBoundingClientRect();
      const position = Math.max(
        0,
        Math.min(bounds.width - 1, clientX - bounds.left),
      );
      const index = Math.min(
        options.length - 1,
        Math.floor((position / bounds.width) * options.length),
      );
      const option = options[index];
      return option && !option.disabled ? option.value : null;
    },
    [options],
  );

  const preview = React.useCallback(
    (nextValue: Value | null) => {
      scrubValueRef.current = nextValue;
      setPreviewValue(nextValue);
      onPreviewChange?.(nextValue);
    },
    [onPreviewChange],
  );

  const cancelScrub = React.useCallback(() => {
    const control = controlRef.current;
    const pointerId = activePointerIdRef.current;
    activePointerIdRef.current = null;
    if (control && pointerId != null && control.hasPointerCapture(pointerId)) {
      control.releasePointerCapture(pointerId);
    }
    pointerStartXRef.current = null;
    pointerStartValueRef.current = null;
    skipPointerClickRef.current = false;
    preview(null);
  }, [preview]);

  React.useEffect(() => {
    const handleWindowBlur = () => cancelScrub();
    globalThis.addEventListener?.("blur", handleWindowBlur);
    return () => {
      globalThis.removeEventListener?.("blur", handleWindowBlur);
      cancelScrub();
    };
  }, [cancelScrub]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !onPreviewChange || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerIdRef.current = event.pointerId;
    pointerStartXRef.current = event.clientX;
    pointerStartValueRef.current = getValueAtPointer(
      event.currentTarget,
      event.clientX,
    );
    scrubValueRef.current = null;
    skipPointerClickRef.current = true;
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const nextValue = getValueAtPointer(event.currentTarget, event.clientX);
    const pointerStartX = pointerStartXRef.current;
    const pointerStartValue = pointerStartValueRef.current;
    const crossedDragThreshold =
      pointerStartX != null && Math.abs(event.clientX - pointerStartX) >= 4;
    if (nextValue == null) return;
    if (
      scrubValueRef.current == null &&
      !crossedDragThreshold &&
      nextValue === pointerStartValue
    ) {
      return;
    }
    if (nextValue !== scrubValueRef.current) preview(nextValue);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    // Releasing over a disabled option keeps the last enabled preview.
    const nextValue =
      getValueAtPointer(event.currentTarget, event.clientX) ??
      scrubValueRef.current;
    activePointerIdRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    pointerStartXRef.current = null;
    pointerStartValueRef.current = null;
    if (nextValue != null) onValueChange(nextValue);
    preview(null);
    globalThis.setTimeout(() => {
      skipPointerClickRef.current = false;
    }, 0);
  };

  const handlePointerCancel = () => cancelScrub();

  const handleLostPointerCapture = () => {
    if (activePointerIdRef.current != null) cancelScrub();
  };

  return (
    <div
      aria-describedby={ariaDescribedBy}
      aria-disabled={disabled || undefined}
      aria-label={legend}
      id={id}
      className={cn(
        "relative isolate h-8 max-w-full shrink-0 overflow-hidden rounded-md bg-muted/45 p-0.5",
        SIZE_CLASSES[size],
        onPreviewChange && "touch-none select-none cursor-ew-resize",
        "aria-disabled:pointer-events-none aria-disabled:opacity-50",
        className,
      )}
      data-slot="segmented-control"
      data-testid={testId}
      onLostPointerCapture={handleLostPointerCapture}
      onPointerCancel={handlePointerCancel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      ref={controlRef}
      role="radiogroup"
    >
      <div
        aria-hidden="true"
        hidden={selectedIndex < 0}
        className={cn(
          "absolute bottom-0.5 left-0.5 top-0.5 z-0 rounded-md bg-background shadow-sm transition-transform duration-200 ease-in-out motion-reduce:transition-none",
          previewValue && "duration-0",
        )}
        data-testid={indicatorTestId ?? `${testId}-indicator`}
        style={{
          transform: `translateX(${selectedIndex * 100}%)`,
          width: `calc((100% - 0.25rem) / ${options.length})`,
        }}
      />
      <div className="grid h-full auto-cols-fr grid-flow-col">
        {options.map(
          ({ value: optionValue, label, Icon, disabled: optionDisabled }) => (
            // biome-ignore lint/a11y/useSemanticElements: segments share one sliding indicator and pointer scrub surface; a styled button with the ARIA radio pattern keeps that layout and the existing option test ids
            <button
              aria-checked={value === optionValue}
              className={cn(
                "relative z-10 flex h-full items-center justify-center gap-1.5 rounded-md bg-transparent px-2.5 text-xs font-medium transition-colors duration-150 ease-out focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none disabled:opacity-50 disabled:cursor-not-allowed",
                displayedValue === optionValue
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              data-testid={`${optionTestIdPrefix}-${optionValue}`}
              disabled={disabled || optionDisabled}
              key={optionValue}
              onClick={(event) => {
                if (disabled || optionDisabled) return;
                if (event.detail > 0 && skipPointerClickRef.current) {
                  skipPointerClickRef.current = false;
                  return;
                }
                onValueChange(optionValue);
              }}
              role="radio"
              tabIndex={optionValue === tabStopValue ? 0 : -1}
              onKeyDown={(event) => {
                if (disabled || event.altKey || event.ctrlKey || event.metaKey)
                  return;
                const enabled = options.filter((option) => !option.disabled);
                const index = enabled.findIndex(
                  (option) => option.value === optionValue,
                );
                let nextIndex: number;
                if (event.key === "ArrowRight" || event.key === "ArrowDown")
                  nextIndex = (index + 1) % enabled.length;
                else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
                  nextIndex = (index - 1 + enabled.length) % enabled.length;
                else if (event.key === "Home") nextIndex = 0;
                else if (event.key === "End") nextIndex = enabled.length - 1;
                else return;
                const next = enabled[nextIndex];
                if (!next) return;
                event.preventDefault();
                onValueChange(next.value);
                const buttons =
                  controlRef.current?.querySelectorAll<HTMLButtonElement>(
                    "button",
                  );
                buttons?.[
                  options.findIndex((option) => option.value === next.value)
                ]?.focus();
              }}
              type="button"
            >
              {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
              {label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
