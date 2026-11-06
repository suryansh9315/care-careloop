import type { ReactNode } from 'react';

/** Small presentational primitives shared across pages. */

export type Tone = 'critical' | 'urgent' | 'routine' | 'ok' | 'info' | 'brand';

export function Badge({ tone, children }: { tone: Tone | 'live'; children?: ReactNode }): JSX.Element {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/**
 * Deterministic avatar colour from the name, so the same patient keeps the
 * same colour across every screen. Hues avoid the red/amber band reserved for
 * severity — a patient must never look urgent because of their initials.
 */
const AVATAR_HUES = [212, 258, 288, 172, 152, 198, 320];

export function Avatar({ name, small }: { name: string; small?: boolean }): JSX.Element {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?';

  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = AVATAR_HUES[hash % AVATAR_HUES.length] ?? 212;

  return (
    <span
      className={`avatar${small ? ' sm' : ''}`}
      style={{ background: `hsl(${hue} 70% 94%)`, color: `hsl(${hue} 55% 34%)` }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  action,
  children,
  padded,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  padded?: boolean;
}): JSX.Element {
  return (
    <section className="card">
      {title && (
        <header className="card-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="sub">{subtitle}</p>}
          </div>
          <div className="spacer" />
          {action}
        </header>
      )}
      {padded ? <div className="card-pad">{children}</div> : children}
    </section>
  );
}

/** A pill used for filters and quick actions. */
export function Chip({
  active,
  onClick,
  tone,
  children,
}: {
  active?: boolean;
  onClick?: () => void;
  tone?: Tone;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`chip${active ? ' active' : ''}${tone ? ` ${tone}` : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A horizontal strip of compact label/value stats — a screen's vital signs. */
export function MetricStrip({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; tone?: Tone }>;
}): JSX.Element {
  return (
    <div className="statstrip">
      {items.map((item, i) => (
        <div key={i} className="statstrip-item">
          <span className={`sv${item.tone ? ` ${item.tone}` : ''}`}>{item.value}</span>
          <span className="sl">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** A tiny inline trend line for at-a-glance history in a row. */
export function Sparkline({
  values,
  width = 76,
  height = 24,
  tone = 'brand',
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: Tone;
}): JSX.Element | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const stroke = `var(--${tone === 'brand' ? 'brand' : tone})`;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 2) + 1;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const lastX = width - 1;
  const lastY = height - 2 - ((values[values.length - 1]! - min) / span) * (height - 4);
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <path d={pts.join(' ')} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX - 1} cy={lastY} r="2.1" fill={stroke} />
    </svg>
  );
}

export function Stat({
  icon,
  value,
  label,
  sub,
  tone = 'brand',
  onClick,
}: {
  icon: ReactNode;
  value: ReactNode;
  label: string;
  sub?: string;
  tone?: Tone;
  onClick?: () => void;
}): JSX.Element {
  const bg: Record<Tone, string> = {
    critical: 'var(--critical-bg)',
    urgent: 'var(--urgent-bg)',
    routine: 'var(--surface-2)',
    ok: 'var(--ok-bg)',
    info: 'var(--info-bg)',
    brand: 'var(--brand-bg)',
  };
  const fg: Record<Tone, string> = {
    critical: 'var(--critical)',
    urgent: 'var(--urgent)',
    routine: 'var(--ink-2)',
    ok: 'var(--ok)',
    info: 'var(--info)',
    brand: 'var(--brand)',
  };
  const inner = (
    <>
      <div className="stat-icon" style={{ background: bg[tone], color: fg[tone] }}>
        {icon}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="card card-pad stat-btn" onClick={onClick}>
        {inner}
        <span className="stat-go" aria-hidden>{Icon.arrowRight()}</span>
      </button>
    );
  }
  return <section className="card card-pad">{inner}</section>;
}

/**
 * Empty states say what would fill the space and how to get there. "No data"
 * leaves the reader unsure whether the system is broken or simply idle.
 */
export function Empty({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="empty">
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }): JSX.Element {
  return (
    <div style={{ padding: '14px 24px' }} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '9px 0' }}>
          <div className="skeleton" style={{ width: 30, height: 30, borderRadius: '50%' }} />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 11, width: `${45 + ((i * 17) % 30)}%` }} />
            <div className="skeleton" style={{ height: 9, width: '30%', marginTop: 7 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  wide,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  wide?: boolean;
}): JSX.Element {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      tabIndex={-1}
    >
      <div className={`modal${wide ? ' wide' : ''}`}>
        <header className="card-head">
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-foot">{footer}</footer>
      </div>
    </div>
  );
}

export function relativeTime(iso: string | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

export function clockTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// --------------------------------------------------------------- icons

const S = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const Icon = {
  pulse: (p = S) => (<svg {...p}><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>),
  home: (p = S) => (<svg {...p}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>),
  live: (p = S) => (<svg {...p}><circle cx="12" cy="12" r="2.5" /><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 16.5a6.4 6.4 0 0 0 0-9" /><path d="M4.5 4.5a10.6 10.6 0 0 0 0 15M19.5 19.5a10.6 10.6 0 0 0 0-15" /></svg>),
  list: (p = S) => (<svg {...p}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>),
  phone: (p = S) => (<svg {...p}><path d="M5 3h3.5l1.8 4.5-2.2 1.3a12.5 12.5 0 0 0 6.1 6.1l1.3-2.2L20 14.5V18a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4 6.2 2 2 0 0 1 6 4z" /></svg>),
  users: (p = S) => (<svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.6A5.5 5.5 0 0 1 20.5 20" /></svg>),
  plus: (p = S) => (<svg {...p}><path d="M12 5v14M5 12h14" /></svg>),
  clipboard: (p = S) => (<svg {...p}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="M9 10h6M9 14h4" /></svg>),
  shield: (p = S) => (<svg {...p}><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" /></svg>),
  inbox: (p = S) => (<svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 13h5l1.5 2.5h5L16 13h5" /></svg>),
  chevron: (p = { ...S, width: 16, height: 16 }) => (<svg {...p}><path d="m9 6 6 6-6 6" /></svg>),
  chevronLeft: (p = { ...S, width: 16, height: 16 }) => (<svg {...p}><path d="m15 6-6 6 6 6" /></svg>),
  arrowRight: (p = { ...S, width: 16, height: 16 }) => (<svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>),
  logout: (p = { ...S, width: 17, height: 17 }) => (<svg {...p}><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 12H3M6 8l-3 4 3 4" /></svg>),
  check: (p = { ...S, width: 15, height: 15 }) => (<svg {...p}><path d="M20 6 9 17l-5-5" /></svg>),
  trend: (p = S) => (<svg {...p}><path d="M3 17l5-6 4 3 6-8" /><path d="M15 6h4v4" /></svg>),
  sun: (p = { ...S, width: 17, height: 17 }) => (<svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>),
  moon: (p = { ...S, width: 17, height: 17 }) => (<svg {...p}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></svg>),
  menu: (p = S) => (<svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></svg>),
  search: (p = { ...S, width: 16, height: 16 }) => (<svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>),
};

// --------------------------------------------------------------- theme

export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'careloop-theme';

export function readTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/**
 * The toggle must win over the OS setting in both directions, so the choice is
 * stamped on the root element and the stylesheet scopes its dark values under
 * both the media query and `[data-theme]`.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
    localStorage.removeItem(THEME_KEY);
  } else {
    root.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }
}

export function resolvedTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
