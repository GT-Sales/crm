'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@gt-sales/ui';

import { getStaffAuth, isStaffAuthConfigured } from '../../lib/supabase-auth';

export default function RecoveryPage() {
  const [updateMode, setUpdateMode] = useState(false);
  const configured = isStaffAuthConfigured();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    setUpdateMode(new URLSearchParams(window.location.search).get('mode') === 'update');
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || busy) return;
    setBusy(true);
    const auth = getStaffAuth();
    try {
      if (updateMode) {
        const result = await auth.updateUser({ password });
        if (result.error) throw result.error;
        setMessage('Password updated. Sign in with the new password.');
      } else {
        await auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/recovery?mode=update`,
        });
        setMessage('If that account exists, a recovery email has been sent.');
      }
    } catch {
      setMessage(
        updateMode
          ? 'The password could not be updated. Request a new recovery email.'
          : 'If that account exists, a recovery email has been sent.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-svh items-center justify-center p-6 outline-none"
    >
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle asChild>
            <h1>Recover staff access</h1>
          </CardTitle>
          <CardDescription>
            Request a recovery email, then set a new password from its link.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <form onSubmit={submit} className="flex flex-col gap-4">
            {updateMode ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  required
                  disabled={!configured || busy}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Label htmlFor="recovery-email">Email</Label>
                <Input
                  id="recovery-email"
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  required
                  disabled={!configured || busy}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
            )}
            <Button type="submit" disabled={!configured || busy}>
              {busy ? 'Please wait…' : updateMode ? 'Update password' : 'Send recovery email'}
            </Button>
          </form>
          {message ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {message}
            </p>
          ) : null}
          <Button asChild variant="outline">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
