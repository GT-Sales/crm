'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { StaffWorkspace } from '@gt-sales/contracts';

import { BackendError, getStaffWorkspaces } from '../lib/api';
import { e2eStaffBearer } from '../lib/e2e-session';
import { getStaffAuth, isStaffAuthConfigured } from '../lib/supabase-auth';

type SessionStatus = 'loading' | 'signed_out' | 'signed_in' | 'configuration_missing' | 'error';

interface StaffSessionState {
  status: SessionStatus;
  accessToken?: string;
  workspaces: readonly StaffWorkspace[];
  reason?: string;
  refreshWorkspaces(): Promise<void>;
  signOut(): Promise<void>;
}

const StaffSessionContext = createContext<StaffSessionState | undefined>(undefined);

export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatusState] = useState<SessionStatus>('loading');
  const [accessToken, setAccessToken] = useState<string>();
  const [workspaces, setWorkspaces] = useState<readonly StaffWorkspace[]>([]);
  const [reason, setReason] = useState<string>();
  const generation = useRef(0);
  // The signed-in user, so a token refresh for the same person only swaps the
  // token instead of reloading (and resetting) every screen.
  const signedInUser = useRef<string | undefined>(undefined);
  // Mirrored synchronously (not in an effect) so an auth event that fires
  // before React flushes effects still sees the status that was just set.
  const statusRef = useRef<SessionStatus>('loading');
  const setStatus = useCallback((next: SessionStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);
  const invalidate = useCallback(() => {
    ++generation.current;
  }, []);

  const load = useCallback(
    async (token: string, userId?: string) => {
      const requestGeneration = ++generation.current;
      signedInUser.current = undefined;
      setAccessToken(undefined);
      setWorkspaces([]);
      setStatus('loading');
      try {
        const result = await getStaffWorkspaces(token);
        if (requestGeneration !== generation.current) return;
        setAccessToken(token);
        setWorkspaces(result.workspaces);
        setReason(undefined);
        signedInUser.current = userId;
        setStatus('signed_in');
      } catch (error) {
        if (requestGeneration !== generation.current) return;
        setAccessToken(undefined);
        setWorkspaces([]);
        setReason(error instanceof BackendError ? error.code : 'internal_error');
        setStatus('error');
      }
    },
    [setStatus],
  );

  useEffect(() => {
    // CQ-01: only the separate e2e build has this; see lib/e2e-session.ts.
    const e2eBearer = e2eStaffBearer();
    if (e2eBearer) {
      void load(e2eBearer);
      return () => invalidate();
    }
    if (!isStaffAuthConfigured()) {
      setStatus('configuration_missing');
      return;
    }
    const auth = getStaffAuth();
    let current = true;
    const initialGeneration = generation.current;
    void auth.getSession().then(({ data }) => {
      if (!current || initialGeneration !== generation.current) return;
      if (data.session) void load(data.session.access_token, data.session.user?.id);
      else setStatus('signed_out');
    });
    const listener = auth.onAuthStateChange((_event, nextSession) => {
      if (!current) return;
      const sameUser =
        nextSession?.user?.id !== undefined &&
        statusRef.current === 'signed_in' &&
        nextSession.user.id === signedInUser.current;
      if (nextSession && sameUser) {
        // TOKEN_REFRESHED / tab refocus for the same person: keep the screen.
        setAccessToken(nextSession.access_token);
        return;
      }
      ++generation.current;
      if (nextSession) void load(nextSession.access_token, nextSession.user?.id);
      else {
        signedInUser.current = undefined;
        setAccessToken(undefined);
        setWorkspaces([]);
        setReason(undefined);
        setStatus('signed_out');
      }
    });
    return () => {
      current = false;
      invalidate();
      listener.data.subscription.unsubscribe();
    };
  }, [load, invalidate, setStatus]);

  const refreshWorkspaces = useCallback(async () => {
    if (accessToken) await load(accessToken, signedInUser.current);
  }, [accessToken, load]);
  const signOut = useCallback(async () => {
    ++generation.current;
    signedInUser.current = undefined;
    setAccessToken(undefined);
    setWorkspaces([]);
    setReason(undefined);
    setStatus('signed_out');
    if (isStaffAuthConfigured()) await getStaffAuth().signOut();
  }, [setStatus]);
  const value = useMemo<StaffSessionState>(
    () => ({ status, accessToken, workspaces, reason, refreshWorkspaces, signOut }),
    [status, accessToken, workspaces, reason, refreshWorkspaces, signOut],
  );

  return <StaffSessionContext.Provider value={value}>{children}</StaffSessionContext.Provider>;
}

export function useStaffSession(): StaffSessionState {
  const value = useContext(StaffSessionContext);
  if (!value) throw new Error('useStaffSession must be used inside StaffSessionProvider');
  return value;
}
