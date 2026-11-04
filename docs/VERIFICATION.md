# Verification scope for this accepted source snapshot

This is a curated public summary, not an export of private runtime logs or credentials. Upstream acceptance is distinct from the filtered public checkout.

| Binding | Recorded upstream result |
| --- | --- |
| Accepted application | `c9e752571c1b92439243fa54653ca10f55127a0f` |
| Backend tree | `54383843f365f6d669ead3e2a4ffdeca9981ae00` |
| Frontend tree | `4903140a396d67b60ab52a7419f3bf26ad90acb7` |
| Maintained backend |218/218 maintained files passed; three pre-existing quarantined files remain separately reported by `backend/tests/run_unit.js`. No claim they passed. |
| Frontend |1,364tests/129files passed; isolated production build47.307s, no source drift. |

These accepted upstream results were independently reported by the integration owner. Later recovery/final-recording results are not included in this source epoch. No claim of successful current hosted demo, final take, every native/browser flow, physical repair or payment follows.

The packaging worker performed only allowlisted source-blob export, file/SHA/canonical checks, static Babel parsing/literal relative-import audit, and a redacted bounded pattern scan. The scanner is custom, with six synthetic pattern checks; it is not Gitleaks/TruffleHog or comprehensive secret/rights certification. Exact staged file/tree approval and scan dispositions are reviewed before publication. No dependency install, live provider, app server, full exported-checkout suite/build or local runtime was run during packaging.

To reproduce independently on an isolated machine after reviewing prerequisites/scripts, use the maintained backend runner (`node tests/run_unit.js` from backend) and frontend Vitest/Vite with empty envDir and actual app plugins. Do not use the generic backend signup `npm test` as the unit suite or point integration scripts at production. See [local setup](PUBLIC_LOCAL_SETUP.md) for explicit offline requirements and current unvalidated setup limits.
