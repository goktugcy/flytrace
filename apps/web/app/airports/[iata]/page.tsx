import { AirportView } from '../../../components/AirportView';

export default async function AirportPage({ params }: { params: Promise<{ iata: string }> }) {
  const { iata } = await params;
  return <AirportView iata={iata} />;
}
