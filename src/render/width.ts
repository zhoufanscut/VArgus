// Terminal columns of a string (DESIGN, "Rules carried over from VantageHUD",
// Width; VantageHUD's src/lib/string-width.js): the line is fitted by this
// count, not by string length, so a wide character or an emoji counts two.
//
// Rules: escape sequences (SGR and other CSI, OSC) count 0; zero-width
// characters, combining marks, variation selectors and skin-tone modifiers
// count 0 (VS16 makes ⚡ into ⚡️, still 2 columns, not 3); East Asian wide
// characters and emoji count 2; everything else 1.
// Known edges, as in VantageHUD: a ZWJ sequence (👨‍👩‍👧) counts each member; a
// text-default symbol plus VS16 counts 1 where most terminals now draw 2; a
// regional indicator counts 1, so a flag (always a pair) counts 2.

// Code point ranges, inclusive, sorted.
const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x1ab0, 0x1aff], // ... extended
  [0x1dc0, 0x1dff], // ... supplement
  [0x200b, 0x200d], // zero-width space, non-joiner, joiner
  [0x20d0, 0x20ff], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
  [0xfeff, 0xfeff], // zero-width no-break space
  [0x1f3fb, 0x1f3ff], // emoji skin-tone modifiers: they recolour the emoji before
  [0xe0100, 0xe01ef], // variation selectors supplement
]

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // Hangul Jamo
  // Every East_Asian_Width=W code point in U+2000-2BFF (Unicode 15.1);
  // narrow neighbours such as ⏱ U+23F1 stay 1.
  [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653],
  [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4],
  [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757],
  [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // Hiragana, Katakana
  [0x3130, 0x318f], // Hangul compatibility Jamo
  [0x31f0, 0x31ff], // Katakana phonetic extensions
  [0x3200, 0x33ff], // enclosed CJK letters, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7af], // Hangul syllables
  [0xd7b0, 0xd7ff], // Hangul Jamo extended B
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff01, 0xff60], // full-width ASCII
  [0xffe0, 0xffe6], // full-width signs
  [0x1f000, 0x1f1e5], // mahjong, dominoes, cards, enclosed supplement (up to the regional indicators)
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x1f300, 0x1f3fa], // pictographs (🔧 U+1F527, 🤖 U+1F916), skin tones carved out above
  [0x1f400, 0x1faff],
  [0x20000, 0x2ebef], // CJK extensions B-F
]

function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false
    if (cp <= hi) return true
  }
  return false
}

const ESCAPES = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

export function stringWidth(text: string): number {
  let width = 0
  for (const ch of text.replace(ESCAPES, '')) {
    const cp = ch.codePointAt(0)!
    if (inRanges(cp, ZERO)) continue
    width += inRanges(cp, WIDE) ? 2 : 1
  }
  return width
}
