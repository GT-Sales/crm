import Link from 'next/link';
import { staffAuthErrorCodeSchema, type StaffAuthErrorCode } from '@gt-sales/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';
import { AuthFrame } from '../../components/auth-frame';

/**
 * What each reason means for the person who landed here: a heading that says
 * what kind of problem it is (only a real refusal says "Access denied") and a
 * sentence that says what to do. The reason code itself is never shown.
 */
const pages: Record<StaffAuthErrorCode, { title: string; description: string }> = {
  invalid_request: {
    title: 'Something is missing',
    description:
      'The CRM could not check your access because the request was not complete. Sign in again to retry.',
  },
  missing_session: {
    title: 'Sign in again',
    description: 'You are not signed in. Sign in to continue.',
  },
  invalid_session: {
    title: 'Sign in again',
    description: 'Your sign-in has expired. Sign in again to continue.',
  },
  workspace_not_found: {
    title: 'Access denied',
    description:
      "This site isn't available to your account. Pick another site, or ask the owner to add you.",
  },
  membership_missing: {
    title: 'Access denied',
    description: "You aren't on this site's team. Ask the owner to invite you.",
  },
  membership_pending: {
    title: 'Invitation not accepted yet',
    description:
      'Your invitation has not been accepted yet. Accept it from the sign-in page, then sign in again.',
  },
  membership_revoked: {
    title: 'Access denied',
    description: 'Your access to this site was removed. Ask the owner if you need it back.',
  },
  permission_denied: {
    title: 'Access denied',
    description:
      "Your role doesn't allow this. Ask the owner to give your role access if you need it.",
  },
  membership_not_found: {
    title: 'Access denied',
    description: 'This team membership no longer exists. Ask the owner to invite you again.',
  },
  membership_conflict: {
    title: 'Already on the team',
    description: 'A membership for this account already exists. Sign in to use it.',
  },
  internal_error: {
    title: 'The CRM is not responding',
    description:
      'The CRM could not check your access just now. Wait a minute, then sign in again; if it keeps happening, tell your admin.',
  },
};

export default async function DeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const result = staffAuthErrorCodeSchema.safeParse((await searchParams).reason);
  const page = pages[result.success ? result.data : 'permission_denied'];

  return (
    <AuthFrame>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle asChild>
            <h1>{page.title}</h1>
          </CardTitle>
          <CardDescription>{page.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    </AuthFrame>
  );
}
