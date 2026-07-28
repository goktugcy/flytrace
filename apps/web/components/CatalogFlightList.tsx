'use client';

import { Badge } from '@/components/ui/badge';
import { useT } from '@/lib/i18n';
import { PlaneLanding, PlaneTakeoff } from 'lucide-react';
import Link from 'next/link';

export interface CatalogFlight {
  flightId: string;
  callsign: string;
  flightNumber: string | null;
  status: string;
  flightDate: string;
  role?: 'departure' | 'arrival';
}

/** Shared compact flight list used by the airport & aircraft pages. */
export function CatalogFlightList({ flights }: { flights: CatalogFlight[] }) {
  const t = useT();
  if (flights.length === 0)
    return <p className="py-2 text-sm text-muted-foreground">{t('catalog.noRecentFlights')}</p>;

  return (
    <ul className="divide-y divide-border">
      {flights.map((f) => (
        <li key={f.flightId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
          {f.role &&
            (f.role === 'departure' ? (
              <PlaneTakeoff className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <PlaneLanding className="size-4 shrink-0 text-muted-foreground" />
            ))}
          <Link
            href={`/flights/id/${f.flightId}`}
            className="font-medium text-accent-bright hover:underline"
          >
            {f.callsign}
          </Link>
          {f.flightNumber && (
            <span className="text-sm text-muted-foreground">{f.flightNumber}</span>
          )}
          <Badge variant="outline" className="ml-auto capitalize">
            {f.status}
          </Badge>
          <span className="hidden text-sm text-muted-foreground sm:inline">{f.flightDate}</span>
        </li>
      ))}
    </ul>
  );
}
