# Fresh local offline judge setup

**Schema-derived instructions; not yet exercised on this exported checkout.** Do not run this against an owner realm, a consumed rehearsal or a production database. No passwords, signing keys or provider key values are distributed. This offline simulation does not qualify as live Meta output or a hosted judge demo.

## Prerequisites

Use your own isolated machine, Node22, Git, locked dependencies and an operator-owned transactional Mongo replica set at `127.0.0.1:27128`, set name `artreloIrisTests`. Standalone Mongo does not support these transactions. Database installation/topology/security is your responsibility; do not point this guard at production or change it to bypass isolation.

Review package lifecycle scripts before installing locked dependencies on your own machine. No packages were installed or servers started while preparing this snapshot. Do not inherit real application/provider secrets and do not create dotenv files in this checkout. The offline guard disables external delivery/payment/model paths and ignores dotenv loading.

## Setup once, then serve

The included `docs/iris-hackathon/public-local-manifest.json` and `public-local-roster.json` are newly authored synthetic examples, not copies of an owner protocol, runtime roster or consumed realm. They create8assigned+2spare local pairs with explicit CAD200 default quota and CAD1000 synthetic opening Wallet. These are example values, not assertions of production defaults or submitted-quote permission. Normal human/cost/consent gates apply.

Run from the repository root in your own interactive terminal:

```powershell
node backend/scripts/judge-sandbox.cjs setup --database artrelo_judge_public_local_test --manifest docs/iris-hackathon/public-local-manifest.json --roster docs/iris-hackathon/public-local-roster.json --frontend http://127.0.0.1:3126 --port 8126
node backend/scripts/judge-sandbox.cjs serve --database artrelo_judge_public_local_test --manifest docs/iris-hackathon/public-local-manifest.json --roster docs/iris-hackathon/public-local-roster.json --frontend http://127.0.0.1:3126 --port 8126
```

You alone enter/confirm the hidden signing values and role passwords during setup, keeping them in your own manager. Use unique16-character passwords for each role account and distinct signing values meeting the launcher's requirements. Never put these values in files, arguments, screenshots or shared messages. Serve requires the same signing values. Setup refuses an existing fixture rather than resetting it. Do not use the ordinary backend server as a substitute for the guarded runtime.

The source guard requires an actual ready synthetic fixture and authenticated role/pair membership; frontend visibility is not an ACL. No build-time `VITE_JUDGE_SANDBOX` lock is implemented in this accepted source. Server status is authoritative. No model key is needed or accepted by this offline setup; the separate live launcher requires its own exact authorised protocol and source binding, not an owner's expiring recording approval.

## Frontend

After dependencies are installed on your own machine, run `node tools/public-local-frontend.mjs` from the repository root. It imports the actual React/Tailwind app config and uses an empty env directory, loopback3126 and explicit `/api` proxy to the fresh local guarded API8126. It does not supply authentication or alter product components. Sign into your own synthetic roles in separate browser profiles; passwords are only the values you privately chose.

Stop your own frontend/backend with Ctrl+C when finished; do not delete/reset unknown databases. No public exposure, tunnel, cloud hosting, real delivery/payment or provider access is part of this setup.

## Test/build limits

The upstream accepted source passed its maintained suites/build. This filtered export has only static relative-import auditing and redacted scanning at packaging time, not a fresh dependency installation, test/build pass or runtime validation. Run the maintained backend unit runner (`cd backend; node tests/run_unit.js`) and frontend maintained suite with an isolated empty-env config before relying on this checkout; known quarantined backend cases remain disclosed. Do not use the backend's generic signup `npm test` against an account or silently skip failing tests. The marketing/static Docker build is not a judge hosting adapter. Report missing prerequisites or failures honestly.
