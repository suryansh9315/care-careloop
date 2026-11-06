/**
 * Number parsing for spoken answers.
 *
 * Risk questions are asked on a phone call, so "about four canisters" and
 * "twice in the last year" are at least as likely as "4" and "2". Matching on
 * /\d+/ alone silently scores those as zero, which turns a critical
 * reliever-overuse finding into no finding at all — the exact failure mode a
 * safety rule must not have.
 */

const WORD_VALUES: Record<string, number> = {
  zero: 0, none: 0, never: 0, nil: 0,
  one: 1, once: 1, a: 1, an: 1, single: 1,
  two: 2, twice: 2, couple: 2, pair: 2,
  three: 3, thrice: 3,
  four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50,
};

/** Phrases that mean "a lot" without naming a number. */
const VAGUE_HIGH = /\b(loads|lots|many|constantly|all the time|too many to count|countless)\b/;

/**
 * Best-effort count from a free-text answer.
 *
 * Returns `undefined` when the answer contains no recoverable number, so a
 * caller can tell "the patient said zero" apart from "we could not tell".
 */
export function parseCount(text: string): number | undefined {
  const lower = text.toLowerCase();

  // Digits win when present — "about 4" and "4-5 times" are unambiguous.
  const digits = lower.match(/\d+/);
  if (digits?.[0]) {
    const value = Number(digits[0]);
    if (Number.isFinite(value)) return value;
  }

  // "twenty five", "thirty two" — compound tens before single words.
  const compound = lower.match(/\b(twenty|thirty|forty|fifty)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/);
  if (compound?.[1] && compound[2]) {
    return (WORD_VALUES[compound[1]] ?? 0) + (WORD_VALUES[compound[2]] ?? 0);
  }

  // "a"/"an" mean one, but only when nothing more specific is present —
  // otherwise "a couple of times" scores as 1 instead of 2.
  const ARTICLES = new Set(['a', 'an']);
  let articleMatch: number | undefined;
  for (const token of lower.split(/[^a-z]+/)) {
    const value = WORD_VALUES[token];
    if (value === undefined) continue;
    if (ARTICLES.has(token)) {
      articleMatch ??= value;
      continue;
    }
    return value;
  }
  if (articleMatch !== undefined) return articleMatch;

  // "loads of them" carries real clinical signal; treat it as above threshold
  // rather than discarding it. Callers see a number they can band.
  if (VAGUE_HIGH.test(lower)) return 99;

  return undefined;
}

/**
 * Whether a free-text answer is affirmative.
 *
 * Negation is checked first: "no, never" and "not really" must not match on
 * the "no"/"really" tokens alone.
 */
export function isAffirmative(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (!lower) return false;
  if (/\b(no|nope|nah|never|not really|not at all|none|don't|dont|didn't|didnt|haven't|havent)\b/.test(lower)) {
    return false;
  }
  return /\b(yes|yeah|yep|yup|correct|true|sure|definitely|absolutely|i have|i do|i did|sometimes|often|occasionally|a bit|a few)\b/.test(
    lower,
  );
}
