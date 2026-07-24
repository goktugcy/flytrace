import { AirportGroundView } from '../../../components/AirportGroundView';

export default async function AirportGroundPage({
  params,
}: {
  params: Promise<{ icao: string }>;
}) {
  const { icao } = await params;
  return <AirportGroundView icao={icao} />;
}
