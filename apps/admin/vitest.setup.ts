import { createElement } from 'react';
import { act, cleanup } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { afterEach, vi } from 'vitest';

import { clearToasts, Toaster } from './src/lib/toast';

// jsdom has no ResizeObserver; Radix controls (checkbox, dialog) measure with it.
class ResizeObserverStub {
  observe = (): void => undefined;
  unobserve = (): void => undefined;
  disconnect = (): void => undefined;
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

// jsdom has no SVG layout. The automation canvas gives React Flow measured
// nodes, so it draws edges at once, and a labelled edge (an if/else Yes/No)
// sizes its label with getBBox; without it the whole page fails to render.
if (typeof SVGElement !== 'undefined' && !('getBBox' in SVGElement.prototype)) {
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
}

// The root layout's toast corner, so a test finds a toast as a page would show it.
const toasterHost = document.createElement('div');
document.body.appendChild(toasterHost);
act(() => {
  createRoot(toasterHost).render(createElement(Toaster));
});

afterEach(() => {
  cleanup();
  act(() => clearToasts());
  // cleanup() empties the body; the toast corner stays for the next test.
  if (!toasterHost.isConnected) document.body.appendChild(toasterHost);
});
