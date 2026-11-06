"""Number parsing for spoken answers.

Ported from `legacy/src/orchestration/numbers.ts`, behaviour-for-behaviour.
`tests/test_golden.py` asserts this against the frozen TypeScript output.

Risk questions are asked on a phone call, so "about four canisters" and "twice
in the last year" are at least as likely as "4" and "2". Matching on ``\\d+``
alone silently scores those as zero, which turns a critical reliever-overuse
finding into no finding at all -- the exact failure mode a safety rule must not
have.
"""

from __future__ import annotations

import re

WORD_VALUES: dict[str, int] = {
    "zero": 0, "none": 0, "never": 0, "nil": 0,
    "one": 1, "once": 1, "a": 1, "an": 1, "single": 1,
    "two": 2, "twice": 2, "couple": 2, "pair": 2,
    "three": 3, "thrice": 3,
    "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "dozen": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
    "thirty": 30, "forty": 40, "fifty": 50,
}

ARTICLES = frozenset({"a", "an"})

#: Phrases that mean "a lot" without naming a number.
VAGUE_HIGH = re.compile(r"\b(loads|lots|many|constantly|all the time|too many to count|countless)\b")

_DIGITS = re.compile(r"\d+")
_COMPOUND = re.compile(
    r"\b(twenty|thirty|forty|fifty)[\s-](one|two|three|four|five|six|seven|eight|nine)\b"
)
_NON_ALPHA = re.compile(r"[^a-z]+")

_NEGATIVE = re.compile(
    r"\b(no|nope|nah|never|not really|not at all|none|don't|dont|didn't|didnt|haven't|havent)\b"
)
_AFFIRMATIVE = re.compile(
    r"\b(yes|yeah|yep|yup|correct|true|sure|definitely|absolutely|i have|i do|i did"
    r"|sometimes|often|occasionally|a bit|a few)\b"
)


def parse_count(text: str) -> int | None:
    """Best-effort count from a free-text answer.

    Returns ``None`` when the answer contains no recoverable number, so a caller
    can tell "the patient said zero" apart from "we could not tell".

    Two inherited quirks are preserved deliberately, because the golden file
    froze them and a silent "fix" here would hide a real divergence:
    ``parse_count("-2") == 2`` (the sign is not part of the ``\\d+`` match) and
    ``parse_count("3.5") == 3`` (only the leading digits match).
    """
    lower = text.lower()

    # Digits win when present -- "about 4" and "4-5 times" are unambiguous.
    digits = _DIGITS.search(lower)
    if digits:
        return int(digits.group(0))

    # "twenty five", "thirty two" -- compound tens before single words.
    compound = _COMPOUND.search(lower)
    if compound:
        return WORD_VALUES.get(compound.group(1), 0) + WORD_VALUES.get(compound.group(2), 0)

    # "a"/"an" mean one, but only when nothing more specific is present --
    # otherwise "a couple of times" scores as 1 instead of 2.
    article_match: int | None = None
    for token in _NON_ALPHA.split(lower):
        value = WORD_VALUES.get(token)
        if value is None:
            continue
        if token in ARTICLES:
            if article_match is None:
                article_match = value
            continue
        return value
    if article_match is not None:
        return article_match

    # "loads of them" carries real clinical signal; treat it as above threshold
    # rather than discarding it. Callers see a number they can band.
    if VAGUE_HIGH.search(lower):
        return 99

    return None


def is_affirmative(text: str) -> bool:
    """Whether a free-text answer is affirmative.

    Negation is checked first: "no, never" and "not really" must not match on
    the "no"/"really" tokens alone.
    """
    lower = text.lower().strip()
    if not lower:
        return False
    if _NEGATIVE.search(lower):
        return False
    return bool(_AFFIRMATIVE.search(lower))
