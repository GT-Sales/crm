import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ScrollEdge } from './scroll-edge';

/** Gives the box the sizes a browser would lay out (jsdom lays out nothing). */
function size(box: HTMLElement, sizes: { scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(box, 'scrollWidth', { configurable: true, value: sizes.scrollWidth });
  Object.defineProperty(box, 'clientWidth', { configurable: true, value: sizes.clientWidth });
}

describe('ScrollEdge', () => {
  it('fades the right edge only while there is more to the right', () => {
    const { container } = render(
      <ScrollEdge>
        <table aria-label="Wide" />
      </ScrollEdge>,
    );
    const box = container.querySelector<HTMLElement>('.overflow-x-auto');
    if (box === null) throw new Error('no scroll box');
    expect(screen.queryByTestId('scroll-edge')).toBeNull();

    size(box, { scrollWidth: 820, clientWidth: 343 });
    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.getByTestId('scroll-edge').getAttribute('aria-hidden')).toBe('true');

    // Scrolled to the end: nothing more to show.
    box.scrollLeft = 477;
    fireEvent.scroll(box);
    expect(screen.queryByTestId('scroll-edge')).toBeNull();

    // A wide screen where the table fits: no fade.
    box.scrollLeft = 0;
    size(box, { scrollWidth: 820, clientWidth: 900 });
    fireEvent.scroll(box);
    expect(screen.queryByTestId('scroll-edge')).toBeNull();
  });
});
