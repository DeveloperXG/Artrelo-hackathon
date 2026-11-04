# Built during the hackathon / pre-existing work

Window: Oct26–Nov4,2026. This public source snapshot is based on accepted application `97e90073bddf0c755d93239c76806bd353983ecb`, including bounded Nov4 recovery source, not a successful final-recording claim. The source manifest supplies exact included files; private operational history is deliberately omitted.

**Pre-existing baseline:** `adec601ba6854e47639c9dd8bf71d59b329e0edd` (Oct24). The existing product already had GPT intake/deterministic fallback, authentication/authorization, vendor matching/outreach, request lifecycle, booking foundations, quote ranges/counteroffers, completion/dispute and generic request activity. This is an extension of that product.

| Work during the window | Representative included sources | Supporting dated implementation |
| --- | --- | --- |
| Bounded Meta triage and explicit provider provenance/fallback | `backend/services/ai/triageProvider.service.js`, `categorization.service.js` | `50b2ddb7b0a165995d3d049bdaebf9a393d98a20`, Oct26local/Oct27UTC |
| Shared new Activity views/projection | `frontend/src/app/components/iris-activity/IrisActivityViews.tsx` | `a926d2df1d6c72ee5fed1aaa1f03411b00668454`, Oct26local/Oct27UTC |
| v2 itemized quote/final statement and typed review UI | `components/request-detail/QuoteReviewPanel.tsx`, `components/landlord/CostReviewDecision.tsx`, `components/quotes/ItemizationEditor.tsx` under `frontend/src/app/` | `d82e463d5e105cbb74d8ef3ef621f5fa10aeffa3`, Oct28 |
| Bounded advisory, clarification and revision gates | `backend/services/quotes/` plus review UI | `a66437a169e997b7d3fcdfcb8e55695e10e697e3`, `a19bc8c756b4380b613783d692184ded683db4e4`, Oct28; `3bf832bf24f67189fd80011f0811fc9f0b76776d`, Oct28local/Oct29UTC |
| Reasoned rescheduling and exact-party consent presentation | `frontend/src/app/components/reschedule/RescheduleRequestForm.tsx` | `e50cc6e22cc6a7ce3fe6e17de56e4ecbe526f239`, Oct29 |
| Global Iris and semantic Policy explanations/proposals | `backend/services/iris/`, frontend Iris panel/components | `0bd96bf38d05f2748e417f01c00b2e2a9b67b71c`, Oct29; `625dc69341e9b10a30cb52cb1a16b143a0b21dfc`, Oct30 |
| Later Guide follow-up and bounded unsent server-window examples; proven section provenance labels | `frontend/src/app/components/judge/`, `components/reschedule/DemoVisitChangeExamples.tsx`, `demoReschedulePrefill.ts` | Reviewed source `c804403bd8547f0cbf5891a50df01dd0e81277a6` / `067466abaf8f795e4cefe739e4d50325dff7a76f`, Nov4, incorporated in this accepted application |

These rows attribute mechanisms, not entire old pages, generic scheduling, payment authority or every model invocation. Earlier implementation commits may not exist as objects in this fresh public history; the IDs and source-blob map provide attribution without exposing private history. No later recovery, recorded take, live deployment or physical repair is claimed by a source listing. Unknown/fallback output remains labelled and synthetic money remains synthetic.

## Nov4 recovery revision

Source `97e90073bddf0c755d93239c76806bd353983ecb` (Nov4): the actual frontend landlord Iris route now shares the guarded router/conversation service with the runtime alias; typed advisory reason/reference validation is bounded; an exact one-shot recording-retake service and CLI preserve existing campaign caps and expiry while bounding one approved take. Sources: `backend/routes/landlord.routes.js`, `backend/routes/iris.routes.js`, `backend/services/judgeSandbox/application.service.js`, `backend/services/quotes/analysisContract.service.js`, `backend/services/judgeSandbox/recordingRetake.service.js`, and the matching contracts/unit tests. This adds no frontend feature, payment authority, physical repair claim or successful live-model take. Original pre-existing baseline and mechanism-level attribution above remain unchanged. Private execution protocols, credentials and evidence are excluded.
