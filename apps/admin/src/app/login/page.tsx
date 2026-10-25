'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
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

import { destinationAfterPrimarySignIn } from '../../lib/auth-navigation';
import { getStaffAuth, isStaffAuthConfigured } from '../../lib/supabase-auth';

export default function LoginPage() {
  const router = useRouter();
  const configured = isStaffAuthConfigured();
  const [acceptingInvitation, setAcceptingInvitation] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || busy) return;
    setBusy(true);
    setMessage(undefined);
    const auth = getStaffAuth();

    try {
      if (acceptingInvitation) {
        const result = await auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/login?invited=1` },
        });
        if (result.error) throw result.error;
        if (result.data.session) {
          router.replace(await destinationAfterPrimarySignIn(result.data.session.access_token));
          return;
        }
        setMessage('If this address can be used, a confirmation email has been sent.');
        return;
      }

      const result = await auth.signInWithPassword({ email, password });
      if (result.error || !result.data.session) throw result.error ?? new Error('no session');
      router.replace(await destinationAfterPrimarySignIn(result.data.session.access_token));
    } catch {
      setMessage(
        acceptingInvitation
          ? 'If this address can be used, a confirmation email has been sent.'
          : 'Invalid email or password.',
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
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle asChild>
            <h1>{acceptingInvitation ? 'Accept staff invitation' : 'Staff sign in'}</h1>
          </CardTitle>
          <CardDescription>
            {acceptingInvitation
              ? 'Use the exact email address your owner invited.'
              : 'Use your GT Sales staff account.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                disabled={!configured || busy}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete={acceptingInvitation ? 'new-password' : 'current-password'}
                minLength={8}
                maxLength={128}
                required
                disabled={!configured || busy}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={!configured || busy} className="w-full">
              {busy ? 'Please wait…' : acceptingInvitation ? 'Create staff account' : 'Sign in'}
            </Button>
          </form>
          {message ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {message}
            </p>
          ) : null}
          {!configured ? (
            <p role="status" className="text-sm text-destructive">
              Staff authentication is not configured for this environment.
            </p>
          ) : null}
          <div className="flex flex-col gap-2 text-center text-sm">
            <button
              type="button"
              className="text-primary underline underline-offset-4"
              onClick={() => {
                setAcceptingInvitation((value) => !value);
                setMessage(undefined);
              }}
            >
              {acceptingInvitation ? 'Return to sign in' : 'I have a staff invitation'}
            </button>
            <Link href="/recovery" className="text-primary underline underline-offset-4">
              Recover access
            </Link>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
