import type * as React from "react";
import { cn } from "@/lib/utils";

export interface AutoReplySwitchProps {
  checked: boolean;
  disabled: boolean;
  ariaLabel: string;
  title?: string;
  onChange: (enabled: boolean) => void;
}

/** Unified pill switch shared by the sidebar and AutomationView for consistent toggle affordance. */
export function AutoReplySwitch({
  checked,
  disabled,
  ariaLabel,
  title,
  onChange,
}: AutoReplySwitchProps): React.ReactElement {
  return (
    <span
      className="relative inline-flex h-[18px] w-[34px] shrink-0 items-center"
      title={title}
    >
      <input
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none flex h-full w-full items-center rounded-full p-0.5 transition-[background-color,box-shadow] duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background peer-disabled:opacity-60",
          checked ? "bg-primary" : "bg-input",
        )}
      >
        <span
          className={cn(
            "block size-3.5 rounded-full bg-background shadow-xs transition-transform duration-150",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </span>
    </span>
  );
}
