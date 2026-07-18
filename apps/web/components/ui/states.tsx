import { cn } from '@/lib/utils';
import { AlertTriangle, type LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { Button } from './button';

/** Centered message scaffold shared by empty/error states. */
function Centered({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center',
        className,
      )}
      {...props}
    />
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <Centered className={className}>
      {Icon && (
        <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </div>
      )}
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </Centered>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description = 'We couldn’t load this. Please try again.',
  onRetry,
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <Centered className={className}>
      <div className="flex size-11 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <AlertTriangle className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Centered>
  );
}

/** Small inline spinner for buttons / inline loading. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
    />
  );
}
