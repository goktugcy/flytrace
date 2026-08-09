'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/lib/i18n';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

interface PromptOptions {
  title?: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
}

interface Pending extends PromptOptions {
  resolve: (password: string | null) => void;
}

/**
 * Collects the password an action re-verifies server-side.
 *
 * Built on the native `<dialog>` element, which supplies the modal semantics
 * that matter for a credential input for free and correctly: a focus trap, an
 * inert background, Escape-to-dismiss, and `aria-modal`. Reimplementing those
 * by hand is where hand-rolled modals leak focus to the page behind them.
 *
 * The password is held in local state for the lifetime of one prompt and
 * cleared the moment it resolves — never lifted into a parent, a form's
 * uncontrolled DOM value, or storage. The caller receives it, sends it, and
 * drops it.
 */
export function usePasswordPrompt(): {
  ask: (options?: PromptOptions) => Promise<string | null>;
  element: ReactNode;
} {
  const t = useT();
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const ask = useCallback(
    (options: PromptOptions = {}) =>
      new Promise<string | null>((resolve) => {
        setValue('');
        setPending({ ...options, resolve });
      }),
    [],
  );

  const finish = useCallback(
    (password: string | null) => {
      pending?.resolve(password);
      setPending(null);
      setValue('');
    },
    [pending],
  );

  // showModal() must be called imperatively — the `open` attribute alone gives a
  // non-modal dialog with no focus trap.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending && !dialog.open) dialog.showModal();
    if (!pending && dialog.open) dialog.close();
  }, [pending]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (value.length === 0) return;
    finish(value);
  }

  const element = (
    <dialog
      ref={dialogRef}
      // Escape and backdrop-driven closes must resolve the promise, or the
      // caller waits forever on a dialog the user already dismissed.
      onCancel={(e) => {
        e.preventDefault();
        finish(null);
      }}
      onClose={() => {
        if (pending) finish(null);
      }}
      className="w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-card-foreground backdrop:bg-black/50"
    >
      {pending && (
        <form onSubmit={onSubmit} className="grid gap-4 p-5">
          <div>
            <h2 className="text-base font-semibold">{pending.title ?? t('sec.password.prompt')}</h2>
            {pending.description && (
              <p className="mt-1 text-sm text-muted-foreground">{pending.description}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">{t('sec.pw.current')}</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="current-password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              /* Autofocus is correct here: the dialog opens in response to a
                 click and its only field is this one. That is a confirmation
                 dialog behaving as expected, not a focus steal on page load. */
              autoFocus
              required
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => finish(null)}>
              {t('sec.mfa.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              variant={pending.destructive ? 'destructive' : 'default'}
              disabled={value.length === 0}
            >
              {pending.confirmLabel ?? t('sec.password.confirm')}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );

  return { ask, element };
}
