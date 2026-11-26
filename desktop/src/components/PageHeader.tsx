import type * as React from 'react';
import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps): React.ReactElement {
  return (
    <header
      className={cn(
        'mb-5 flex flex-wrap items-start justify-between gap-4',
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <h1 className="font-heading text-[19px] font-semibold leading-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
