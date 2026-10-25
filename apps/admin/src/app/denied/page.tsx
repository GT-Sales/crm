import Link from 'next/link';
import { staffAuthErrorCodeSchema, type StaffAuthErrorCode } from '@gt-sales/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';

const descriptions: Record<StaffAuthErrorCode, string> = {
  invalid_request: 'The requested staff action was invalid.',
  missing_session: 'Sign in to continue.',
  invalid_session: 'Your session is invalid or expired. Sign in again.',
  workspace_not_found: 'This workspace is not available to your account.',
  membership_missing: 'Your account has no active membership for this workspace.',
  membership_pending: 'Your membership has not been accepted yet.',
  membership_revoked: 'Your membership has been revoked.',
  permission_denied: 'Your current roles and permissions do not allow this action.',
  membership_not_found: 'The requested membership is unavailable.',
  membership_conflict: 'A matching membership already exists.',
  internal_error: 'The authorization check could not be completed.',
};

export default async function DeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const result = staffAuthErrorCodeSchema.safeParse((await searchParams).reason);
  const reason = result.success ? result.data : 'permission_denied';

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-svh items-center justify-center p-6 outline-none"
    >
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle asChild>
            <h1>Access denied</h1>
          </CardTitle>
          <CardDescription>{descriptions[reason]}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-center font-mono text-xs text-muted-foreground">Reason: {reason}</p>
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
