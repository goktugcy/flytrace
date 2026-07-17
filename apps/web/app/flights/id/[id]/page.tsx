import { FlightView } from '../../../../components/FlightView';

export default async function FlightPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FlightView flightId={id} />;
}
