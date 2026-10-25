'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
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

import { destinationAfterPrimarySignIn } from '../../../lib/auth-navigation';
import { getStaffAuth, isStaffAuthConfigured } from '../../../lib/supabase-auth';

export default function MfaChallengePage() {
  const router = useRouter();
  const configured = isStaffAuthConfigured();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [factors, setFactors] = useState<readonly { id: string; name: string }[]>([]);
  const [factorId, setFactorId] = useState('');

  useEffect(() => {
    if (!configured) return;
    let active = true;
    async function load() {
      try {
        const result = await getStaffAuth().mfa.listFactors();
        if (result.error) throw result.error;
        if (!active) return;
        const verified = result.data.totp.filter((factor) => factor.status === 'verified');
        if (!verified.length) {
          router.replace('/mfa/enroll');
          return;
        }
        setFactors(
          verified.map((factor, index) => ({
            id: factor.id,
            name: factor.friendly_name?.trim() || `Authenticator ${index + 1}`,
          })),
        );
        setFactorId(verified[0]?.id ?? '');
      } catch {
        if (active) setMessage('Could not load authenticators. Reload the page to try again.');
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [configured, router]);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || busy || !factorId) return;
    setBusy(true);
    setMessage(undefined);
    const auth = getStaffAuth();
    try {
      const currentFactors = await auth.mfa.listFactors();
      if (currentFactors.error) throw currentFactors.error;
      const factor = currentFactors.data.totp.find(
        (item) => item.id === factorId && item.status === 'verified',
      );
      if (!factor) {
        setMessage(
          'That authenticator is no longer available. Reload the page and choose another.',
        );
        return;
      }
      const verified = await auth.mfa.challengeAndVerify({ factorId: factor.id, code });
      if (verified.error) throw verified.error;
      const current = await auth.getSession();
      if (!current.data.session) throw new Error('no verified session');
      router.replace(await destinationAfterPrimarySignIn(current.data.session.access_token));
    } catch {
      setMessage('The verification code was not accepted. Try a new code.');
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
            <h1>Verify multi-factor access</h1>
          </CardTitle>
          <CardDescription>Enter the current code from your authenticator app.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={verify} className="flex flex-col gap-4">
            {factors.length > 1 ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="totp-factor">Authenticator</Label>
                <select
                  id="totp-factor"
                  value={factorId}
                  disabled={busy}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  onChange={(event) => {
                    setFactorId(event.target.value);
                    setCode('');
                  }}
                >
                  {factors.map((factor) => (
                    <option key={factor.id} value={factor.id}>
                      {factor.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="totp-code">Authenticator code</Label>
              <Input
                id="totp-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                required
                disabled={!configured || busy}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={!configured || busy || !factorId}>
              {busy ? 'Verifying…' : 'Verify'}
            </Button>
          </form>
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
          <Link href="/recovery" className="text-center text-sm text-primary underline">
            I lost access to this authenticator
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
