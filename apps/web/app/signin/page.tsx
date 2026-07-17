import { AuthForm } from '../../components/AuthForm';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return <AuthForm next={next ?? '/map'} />;
}
