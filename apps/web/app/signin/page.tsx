import { headers } from 'next/headers';
import { AuthForm } from '../../components/AuthForm';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return <AuthForm next={next ?? '/map'} nonce={nonce} />;
}
