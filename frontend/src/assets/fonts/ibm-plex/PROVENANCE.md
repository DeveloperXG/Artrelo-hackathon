# IBM Plex — self-hosted font provenance

The eight `.woff2` files in this folder are **unmodified** copies of IBM's
official release files: not subset, converted, renamed or re-encoded. They are
served by this app only (Vite fingerprints them under `/assets/`); the marketing
app does not import them.

Copyright © 2017 IBM Corp. with Reserved Font Name "Plex". Licensed under the
SIL Open Font License 1.1 — the full text is in `LICENSE.txt` beside this file,
the `LICENSE.txt` from the root of both release archives (identical in the two;
sha256 `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` as
shipped, with CRLF line endings). Git stores it with LF line endings, so the
committed blob hashes differently
(`37784b44044a4ffd9256702b7c0982c37e5c8887ba90c6dca0479aea93dc898d`, equal to
the upstream file with CR removed); the text is unchanged. The font files are binary and byte-identical.
Because the files are unmodified, the reserved name "IBM Plex" is used as
published. Do not sell these files on their own, and keep this notice and the
licence with any copy.

## Sources

| Family | Release tag | Tag commit | Archive | Archive sha256 |
| --- | --- | --- | --- | --- |
| IBM Plex Sans | `@ibm/plex-sans@1.1.0` (published 2024-11-13) | `1da12f02587b630c07e92692d21492d722f53614` | `ibm-plex-sans.zip`, 9 921 777 bytes | `fb365d910566e6d199cc2c15579a7dd9a267128e18431a394ed81f1970c69200` |
| IBM Plex Mono | `@ibm/plex-mono@2.5.0` (published 2026-06-11) | `2f9ba1b25957d958db71a849e85d72e3ecfb845a` | `ibm-plex-mono.zip`, 6 940 652 bytes | `6d23f01257663d8cc49a0d64c22ced630b79e0e2a0ac08a0da86e9a38bbc481c` (matches GitHub's published asset digest) |

Archive URLs:

- https://github.com/IBM/plex/releases/download/%40ibm%2Fplex-sans%401.1.0/ibm-plex-sans.zip
- https://github.com/IBM/plex/releases/download/%40ibm%2Fplex-mono%402.5.0/ibm-plex-mono.zip

Each file was taken from the archive's `fonts/complete/woff2/` folder (the
full-coverage static instances, not the `split/` per-script subsets).

## Files

| File | Family | Weight | Bytes | sha256 |
| --- | --- | --- | --- | --- |
| IBMPlexSans-Regular.woff2 | IBM Plex Sans | 400 | 63 020 | `ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a` |
| IBMPlexSans-Medium.woff2 | IBM Plex Sans | 500 | 66 740 | `5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d` |
| IBMPlexSans-SemiBold.woff2 | IBM Plex Sans | 600 | 67 060 | `f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205` |
| IBMPlexSans-Bold.woff2 | IBM Plex Sans | 700 | 63 012 | `fa7130d854a660b39a7fc9e6e0f2dc23dba5f1346e2adea3e1fe37b6d884133d` |
| IBMPlexMono-Regular.woff2 | IBM Plex Mono | 400 | 49 248 | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` |
| IBMPlexMono-Medium.woff2 | IBM Plex Mono | 500 | 50 400 | `33faf307fa6031fb4062276d7320a6d632de890cbb347576fd80cfa01077bc25` |
| IBMPlexMono-SemiBold.woff2 | IBM Plex Mono | 600 | 50 600 | `6a825b4824c01cbb401e829e5a066a1818411bcb3538b5a5792c5ca9b82343c3` |
| IBMPlexMono-Bold.woff2 | IBM Plex Mono | 700 | 50 380 | `ea576f38d05cc44cca48c45314984beb8cc1d2b886f58e1dce99f15dc344eb1d` |

These are static, upright instances only: four weights per family, no italics
and no variable font. `fonts.css` declares exactly these eight faces, and
`fonts.test.ts` fails if any file's bytes stop matching the hashes above.

## Glyph coverage

The complete files cover the union of the per-script `unicode-range`s that the
same releases declare in their own `css/*-all.css` for the split subsets:

- Sans: Latin-1, Latin-2 (Latin Extended A/B, Vietnamese), Latin-3, Greek,
  Cyrillic and "Pi" (arrows, maths, fractions, ✓, ❌).
- Mono: the same without Greek.

Both include `$`, `£`, `€` (U+20AC), en/em dashes, curly quotes, `…`, `™` and the
minus sign U+2212. Anything outside these ranges (CJK, Arabic, emoji) falls
through to the system and emoji stacks in `theme.css`.
