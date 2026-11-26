import type * as React from "react";
import { cn } from "@/lib/utils";

export function AppHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <header
      className={cn(
        "mb-6 flex flex-wrap items-start justify-between gap-4",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <h1 className="font-semibold text-[19px] text-foreground leading-tight">
          {title}
        </h1>
        {description && (
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
