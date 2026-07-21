'use client';

import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

function applyTheme(theme: 'light' | 'dark') {
  const el = document.documentElement;
  el.classList.toggle('dark', theme === 'dark');
  el.style.colorScheme = theme;
  try {
    localStorage.setItem('flytrace.theme', theme);
    document.cookie = `flytrace.theme=${theme};path=/;max-age=31536000;samesite=lax`;
  } catch {
    /* storage blocked — class still applied for this session */
  }
}

/** Light/dark toggle. The pre-paint script in the layout sets the initial theme
 * (saved choice or OS preference); this reflects + flips it, persisting to a
 * cookie so SSR matches on the next load. */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useT();
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggle = () => {
    const next = !document.documentElement.classList.contains('dark');
    applyTheme(next ? 'dark' : 'light');
    setDark(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? t('theme.toLight') : t('theme.toDark')}
      title={dark ? t('theme.toLight') : t('theme.toDark')}
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      {/* Render the icon only after mount so SSR (theme-unknown) can't mismatch. */}
      {dark === null ? (
        <span className="size-4" />
      ) : dark ? (
        <Sun className="size-4" />
      ) : (
        <Moon className="size-4" />
      )}
    </button>
  );
}
