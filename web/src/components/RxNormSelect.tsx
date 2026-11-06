import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui';

/**
 * A debounced RxNorm search with a dropdown of real drug concepts.
 *
 * The medication editor previously took a free-text RxNorm code, which is the
 * one field where a typo is genuinely dangerous — a wrong RxCUI is a valid-
 * looking code for a different drug. Concepts are resolved against NIH's public
 * RxNav API (no key, CORS-enabled):
 *   drugs.json      — strength-level prescribable products, for complete words
 *   approximateTerm — ranks partial, as-you-type input
 * Results are merged prescribable-first and deduped by RxCUI. If the network
 * fails the raw text is still accepted, so the control degrades to what it
 * replaced rather than blocking the reviewer.
 */

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';

/** Term types worth prescribing against — strength-level products and packs. */
const PRESCRIBABLE = new Set(['SCD', 'SBD', 'SCDF', 'SBDF', 'SCDC', 'SBDC', 'GPCK', 'BPCK']);

export interface RxConcept { code: string; display: string }
interface Match extends RxConcept { tty?: string }

async function searchRxNorm(term: string, signal: AbortSignal): Promise<Match[]> {
  const q = term.trim();
  if (q.length < 2) return [];

  const [drugs, approx] = await Promise.allSettled([
    fetch(`${RXNAV}/drugs.json?name=${encodeURIComponent(q)}`, { signal }).then((r) => r.json()),
    fetch(`${RXNAV}/approximateTerm.json?term=${encodeURIComponent(q)}&maxEntries=20`, { signal }).then((r) => r.json()),
  ]);

  const byCode = new Map<string, Match>();

  if (drugs.status === 'fulfilled') {
    for (const group of drugs.value?.drugGroup?.conceptGroup ?? []) {
      if (!PRESCRIBABLE.has(group.tty)) continue;
      for (const c of group.conceptProperties ?? []) {
        if (c.rxcui && c.name && !byCode.has(c.rxcui)) {
          byCode.set(c.rxcui, { code: c.rxcui, display: c.name, tty: group.tty });
        }
      }
    }
  }
  if (approx.status === 'fulfilled') {
    for (const c of approx.value?.approximateGroup?.candidate ?? []) {
      if (c.rxcui && c.name && !byCode.has(c.rxcui)) byCode.set(c.rxcui, { code: c.rxcui, display: c.name });
    }
  }
  return [...byCode.values()].slice(0, 12);
}

export function RxNormSelect({
  value,
  onChange,
  disabled,
}: {
  value: RxConcept;
  onChange: (next: RxConcept) => void;
  disabled?: boolean;
}): JSX.Element {
  const [text, setText] = useState(value.display);
  const [matches, setMatches] = useState<Match[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null);
  const justSelected = useRef(false);

  useEffect(() => setText(value.display), [value.display]);

  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Debounced lookup; the controller cancels an in-flight query when the term
  // moves on, so a slow response can never overwrite a newer one. The guard is
  // "did the user just pick something", not "does the text match the value" —
  // the value tracks every keystroke, so comparing them never searches.
  useEffect(() => {
    if (justSelected.current) { justSelected.current = false; setMatches([]); return; }
    if (!open || text.trim().length < 2) { setMatches([]); return; }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      searchRxNorm(text, controller.signal)
        .then((found) => { setMatches(found); setActive(-1); })
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); setLoading(false); };
  }, [text, open]);

  function choose(match: Match): void {
    justSelected.current = true;
    onChange({ code: match.code, display: match.display });
    setText(match.display);
    setOpen(false);
  }

  return (
    <div className="rx" ref={wrap}>
      <input
        value={text}
        disabled={disabled}
        placeholder="Search RxNorm…"
        aria-label="Medication"
        onChange={(e) => { setText(e.target.value); setOpen(true); onChange({ code: value.code, display: e.target.value }); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(matches[active]!); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && (loading || matches.length > 0) && (
        <div className="rx-menu" role="listbox">
          {loading && matches.length === 0 && <div className="rx-empty">Searching RxNorm…</div>}
          {matches.map((m, i) => (
            <button
              key={m.code}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`rx-opt${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(m)}
            >
              <span className="rx-name">{m.display}</span>
              <span className="rx-code mono">
                {m.tty && <span className="rx-tty">{m.tty}</span>}
                {m.code}
              </span>
            </button>
          ))}
        </div>
      )}
      {value.code && (
        <p className="rx-current small muted">
          {Icon.check()} RxCUI <span className="mono">{value.code}</span>
        </p>
      )}
    </div>
  );
}
