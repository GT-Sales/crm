import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom has no ResizeObserver; Radix controls (checkbox, dialog) measure with it.
class ResizeObserverStub {
  observe = (): void => undefined;
  unobserve = (): void => undefined;
  disconnect = (): void => undefined;
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

afterEach(() => {
  cleanup();
});
