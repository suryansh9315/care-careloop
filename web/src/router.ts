import { useCallback, useEffect, useState } from 'react';

/**
 * Hash routing.
 *
 * The app had no URL state at all, so the browser's back button could only
 * leave the app and no screen could be linked to or reloaded. Hash routes are
 * used rather than history paths because the dashboard is served as a static
 * bundle — a deep path like /review/123 would 404 on refresh unless the host
 * is configured to rewrite every path to index.html, and a hash needs no
 * server cooperation at all.
 */

export type Route =
  | 'dashboard'
  | 'live'
  | 'review'
  | 'calls'
  | 'patients'
  | 'intake'
  | 'treatments'
  | 'patient';

const ROUTES: Route[] = [
  'dashboard', 'live', 'review', 'calls', 'patients', 'intake', 'treatments', 'patient',
];

export interface Location {
  route: Route;
  /** The id segment, when the route addresses one resource. */
  id?: string;
}

export function parseHash(hash: string): Location {
  const [rawRoute, rawId] = hash.replace(/^#\/?/, '').split('/');
  const route = ROUTES.find((r) => r === rawRoute) ?? 'dashboard';
  return { route, id: rawId ? decodeURIComponent(rawId) : undefined };
}

export function hashFor(route: Route, id?: string): string {
  return `#/${route}${id ? `/${encodeURIComponent(id)}` : ''}`;
}

export function useHashLocation(): {
  location: Location;
  navigate: (route: Route, id?: string) => void;
  replace: (route: Route, id?: string) => void;
} {
  const [location, setLocation] = useState<Location>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setLocation(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    // Land on a real route so the first Back press has somewhere to return to.
    if (!window.location.hash) window.history.replaceState(null, '', hashFor('dashboard'));
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((route: Route, id?: string) => {
    const next = hashFor(route, id);
    if (next === window.location.hash) return;
    window.location.hash = next;
  }, []);

  // Used when a navigation should not add a history entry of its own.
  const replace = useCallback((route: Route, id?: string) => {
    const next = hashFor(route, id);
    if (next === window.location.hash) return;
    window.history.replaceState(null, '', next);
    setLocation(parseHash(next));
  }, []);

  return { location, navigate, replace };
}
