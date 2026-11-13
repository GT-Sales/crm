import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { beginActivity, resetActivityForTests, trackedFetch } from '../lib/activity';
import { TopLoadingBar } from './top-loading-bar';

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/getcanadasim/leads',
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  resetActivityForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function bar() {
  return screen.getByTestId('top-loading-bar');
}

it('stays hidden for work that finishes quickly', () => {
  render(<TopLoadingBar />);
  let end!: () => void;
  act(() => {
    end = beginActivity();
  });
  act(() => vi.advanceTimersByTime(100));
  act(() => end());
  act(() => vi.advanceTimersByTime(1000));
  expect(bar().dataset.phase).toBe('idle');
});

it('shows while work runs, then fills and hides', () => {
  render(<TopLoadingBar />);
  let end!: () => void;
  act(() => {
    end = beginActivity();
  });
  act(() => vi.advanceTimersByTime(200));
  expect(bar().dataset.phase).toBe('loading');
  act(() => end());
  expect(bar().dataset.phase).toBe('finishing');
  act(() => vi.advanceTimersByTime(600));
  expect(bar().dataset.phase).toBe('idle');
});

it('stays on until the last of several requests ends', () => {
  render(<TopLoadingBar />);
  let first!: () => void;
  act(() => {
    first = beginActivity();
  });
  let second!: () => void;
  act(() => {
    second = beginActivity();
  });
  act(() => vi.advanceTimersByTime(200));
  act(() => first());
  expect(bar().dataset.phase).toBe('loading');
  act(() => second());
  expect(bar().dataset.phase).toBe('finishing');
});

it('counts a backend request until its response arrives, even when it fails', async () => {
  let fail!: (error: Error) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((_, reject) => (fail = reject))),
  );
  render(<TopLoadingBar />);
  const request = trackedFetch('https://api.example.test/x').catch(() => undefined);
  act(() => vi.advanceTimersByTime(200));
  expect(bar().dataset.phase).toBe('loading');
  await act(async () => {
    fail(new TypeError('offline'));
    await request;
  });
  expect(bar().dataset.phase).toBe('finishing');
});

it('starts on a click to another CRM page', () => {
  render(
    <>
      <TopLoadingBar />
      <a href="/w/getcanadasim/dashboard" onClick={(event) => event.preventDefault()}>
        Dashboard
      </a>
    </>,
  );
  // The capture listener runs before the link's own handler prevents the default.
  act(() => screen.getByText('Dashboard').click());
  act(() => vi.advanceTimersByTime(200));
  expect(bar().dataset.phase).toBe('loading');
});
