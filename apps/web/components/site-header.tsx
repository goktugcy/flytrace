'use client';

import { SearchBox } from '@/components/SearchBox';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { LayoutDashboard, Map as MapIcon, Menu, Plane, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const NAV = [
  { href: '/map', label: 'Map', icon: MapIcon },
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
];

interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
}

export function SiteHeader() {
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/auth/session`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setUser((d?.data?.user as SessionUser | undefined) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the mobile menu on navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on path change
  useEffect(() => setMenuOpen(false), [pathname]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/80 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-soft">
            <Plane className="size-4" />
          </span>
          <span>FlyTrace</span>
        </Link>

        <nav className="ml-2 hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                isActive(item.href)
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-3 md:flex">
          <SearchBox className="w-64" />
          <AccountSlot user={user} />
        </div>

        <button
          type="button"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className="ml-auto inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
        >
          {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      {menuOpen && (
        <div className="border-t border-border bg-background px-4 py-4 md:hidden">
          <SearchBox className="mb-4" />
          <nav className="flex flex-col gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive(item.href)
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="mt-4">
            <AccountSlot user={user} full />
          </div>
        </div>
      )}
    </header>
  );
}

function AccountSlot({ user, full }: { user: SessionUser | null; full?: boolean }) {
  if (!user) {
    return (
      <Button asChild size="sm" className={cn(full && 'w-full')}>
        <Link href="/signin">Sign in</Link>
      </Button>
    );
  }
  const initial = (user.name ?? user.email).charAt(0).toUpperCase();
  return (
    <Link
      href="/dashboard"
      className={cn(
        'flex items-center gap-2 rounded-md text-sm transition-colors hover:bg-accent',
        full ? 'w-full px-3 py-2' : 'px-1.5 py-1',
      )}
    >
      <span className="flex size-7 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
        {initial}
      </span>
      {full && <span className="truncate text-muted-foreground">{user.email}</span>}
    </Link>
  );
}
