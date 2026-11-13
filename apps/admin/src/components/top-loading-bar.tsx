'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { beginActivity, isBusy, subscribeActivity } from '../lib/activity';

/** Work shorter than this never shows the bar, so quick saves don't flicker. */
const SHOW_AFTER_MS = 150;
/** Longest a navigation may hold the bar if the new page never reports in. */
const NAVIGATION_GIVE_UP_MS = 15_000;

type Phase = 'idle' | 'loading' | 'finishing' | 'fading';

/**
 * A thin bar across the top of every page while the CRM is loading: a page
 * change, or any request to the backend. It creeps towards the right while
 * work is running and fills up and fades out when it is done.
 */
export function TopLoadingBar() {
  const pathname = usePathname();
  // Compared as text: a new object with the same query is not a new page.
  const search = useSearchParams().toString();
  const [phase, setPhase] = useState<Phase>('idle');
  const [width, setWidth] = useState(0);
  const endNavigation = useRef<(() => void) | null>(null);

  // A click on a link to another CRM page starts a navigation...
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      const anchor = target instanceof Element ? target.closest('a') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return;
      endNavigation.current?.();
      const end = beginActivity();
      const giveUp = window.setTimeout(end, NAVIGATION_GIVE_UP_MS);
      endNavigation.current = () => {
        window.clearTimeout(giveUp);
        end();
        endNavigation.current = null;
      };
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // ...and the new address arriving ends it.
  useEffect(() => {
    endNavigation.current?.();
  }, [pathname, search]);

  useEffect(() => {
    let showTimer: number | undefined;
    let creepTimer: number | undefined;
    let hideTimer: number | undefined;

    function start() {
      window.clearTimeout(hideTimer);
      if (showTimer !== undefined || creepTimer !== undefined) return;
      showTimer = window.setTimeout(() => {
        showTimer = undefined;
        setPhase('loading');
        setWidth(15);
        // Creep towards 90 %, slower the further it gets; never reaches the end.
        creepTimer = window.setInterval(() => {
          setWidth((current) => Math.min(90, current + (90 - current) * 0.08));
        }, 200);
      }, SHOW_AFTER_MS);
    }

    function finish() {
      if (showTimer !== undefined) {
        // Done before the bar ever showed: nothing to animate.
        window.clearTimeout(showTimer);
        showTimer = undefined;
        return;
      }
      if (creepTimer === undefined) return;
      window.clearInterval(creepTimer);
      creepTimer = undefined;
      setPhase('finishing');
      setWidth(100);
      hideTimer = window.setTimeout(() => {
        setPhase('fading');
        hideTimer = window.setTimeout(() => {
          setPhase('idle');
          setWidth(0);
        }, 300);
      }, 250);
    }

    if (isBusy()) start();
    const unsubscribe = subscribeActivity((busy) => (busy ? start() : finish()));
    return () => {
      unsubscribe();
      window.clearTimeout(showTimer);
      window.clearInterval(creepTimer);
      window.clearTimeout(hideTimer);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      data-testid="top-loading-bar"
      data-phase={phase}
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px]"
    >
      <div
        className={`h-full bg-primary shadow-[0_0_8px_var(--primary)] ease-out motion-reduce:transition-none ${
          phase === 'idle' ? 'transition-none' : 'transition-[width,opacity] duration-300'
        }`}
        style={{
          width: `${width}%`,
          opacity: phase === 'loading' || phase === 'finishing' ? 1 : 0,
        }}
      />
    </div>
  );
}
