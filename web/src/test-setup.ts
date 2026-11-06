import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom implements neither of these, and the theme toggle and responsive
// layout both call them during render.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

window.confirm = vi.fn(() => true);
