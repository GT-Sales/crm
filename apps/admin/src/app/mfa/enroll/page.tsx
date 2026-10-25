'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
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

interface Enrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

export default function MfaEnrollPage() {
  const router = useRouter();
  const started = useRef(false);
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isStaffAuthConfigured() || started.current) return;
    started.current = true;
    const auth = getStaffAuth();
    void auth.mfa.listFactors().then(async (factors) => {
      if (factors.error) {
        setMessage('Multi-factor enrollment could not be started.');
        return;
      }
      if (factors.data.totp.some((factor) => factor.status === 'verified')) {
        const assurance = await auth.mfa.getAuthenticatorAssuranceLevel();
        if (assurance.error || assurance.data.currentLevel !== 'aal2') {
          router.replace('/mfa/challenge');
          return;
        }
      }
      // BUG-05: an abandoned attempt (reload, closed tab, QR that did not scan)
      // leaves an unverified factor behind, and Supabase rejects a second factor
      // with the same name. Remove those leftovers first; `totp` lists only
      // verified factors, so they are found in `all`.
      for (const stale of factors.data.all) {
        if (stale.factor_type === 'totp' && stale.status === 'unverified') {
          await auth.mfa.unenroll({ factorId: stale.id });
        }
      }
      const result = await auth.mfa.enroll({
        factorType: 'totp',
        // A unique name as well, so one failed clean-up cannot block enrolment.
        friendlyName: `GT Sales CRM Admin ${new Date().toISOString().slice(0, 16)}`,
      });
      if (result.error || result.data.type !== 'totp') {
        setMessage('Multi-factor enrollment could not be started. Reload the page to try again.');
        return;
      }
      setEnrollment({
        factorId: result.data.id,
        qrCode: result.data.totp.qr_code,
        secret: result.data.totp.secret,
      });
    });
  }, [router]);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollment || busy) return;
    setBusy(true);
    setMessage(undefined);
    const auth = getStaffAuth();
    try {
      const result = await auth.mfa.challengeAndVerify({ factorId: enrollment.factorId, code });
      if (result.error) throw result.error;
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
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle asChild>
            <h1>Set up multi-factor access</h1>
          </CardTitle>
          <CardDescription>
            Owner and Finance actions stay locked until this login reaches verified aal2.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {enrollment ? (
            <>
              <img
                src={enrollment.qrCode}
                alt="Authenticator setup QR code"
                className="mx-auto size-52 rounded bg-white p-2"
              />
              <p className="break-all rounded border p-3 font-mono text-xs">
                Manual key: {enrollment.secret}
              </p>
              <form onSubmit={verify} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="enrollment-code">Authenticator code</Label>
                  <Input
                    id="enrollment-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    minLength={6}
                    maxLength={6}
                    required
                    disabled={busy}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </div>
                <Button type="submit" disabled={busy}>
                  {busy ? 'Enabling…' : 'Enable MFA'}
                </Button>
              </form>
            </>
          ) : (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              Preparing authenticator setup…
            </p>
          )}
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
