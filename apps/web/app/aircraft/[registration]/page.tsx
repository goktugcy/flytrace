import { AircraftView } from '../../../components/AircraftView';

export default async function AircraftPage({
  params,
}: {
  params: Promise<{ registration: string }>;
}) {
  const { registration } = await params;
  return <AircraftView registration={registration} />;
}
