import { AdaptiveSegmentedControl } from "@/shared/ui/adaptive-segmented-control";
import { PersonaDropdownField } from "./PersonaDropdownField";
import type { PersonaDropdownOption } from "./agentConfigOptions";

/** Presentation only: values, persistence and capability policy stay with callers. */
export function PersonaChoiceField({
  label,
  maxOptions,
  ...props
}: {
  label: string;
  maxOptions?: number;
  ariaDescribedBy?: string;
  disabled?: boolean;
  id: string;
  onValueChange: (value: string) => void;
  options: readonly PersonaDropdownOption[];
  placeholder: string;
  value: string;
}) {
  return (
    <AdaptiveSegmentedControl
      {...props}
      fallback={<PersonaDropdownField {...props} />}
      legend={label}
      maxOptions={maxOptions}
    />
  );
}
