import { useEffect } from 'react';
import { Check } from 'lucide-react';
import type { RequestWorkflowStage } from './requestDetailTypes';
import { WORKFLOW_STEPS } from './requestDetailTypes';

/** Injects the one-time fill animation used by the workflow connector lines. */
function useWorkflowFillAnimation() {
  useEffect(() => {
    if (document.getElementById('rwp-fill-styles')) return;
    const style = document.createElement('style');
    style.id = 'rwp-fill-styles';
    style.textContent = `
      @keyframes rwpGrowY { from { transform: scaleY(0); } to { transform: scaleY(1); } }
      @keyframes rwpGrowX { from { transform: scaleX(0); } to { transform: scaleX(1); } }
      @keyframes rwpPop {
        0% { opacity: 0; transform: scale(0.4); }
        60% { opacity: 1; transform: scale(1.08); }
        100% { opacity: 1; transform: scale(1); }
      }
      .rwp-fill { transform-origin: top; animation: rwpGrowY 0.55s cubic-bezier(0.16, 0.84, 0.44, 1) both; }
      .rwp-pop { animation: rwpPop 0.45s cubic-bezier(0.16, 0.84, 0.44, 1) both; }
      @media (min-width: 640px) {
        .rwp-fill { transform-origin: left; animation-name: rwpGrowX; }
      }
      @media (prefers-reduced-motion: reduce) {
        .rwp-fill, .rwp-pop { animation: none !important; transform: none !important; }
      }
    `;
    document.head.appendChild(style);
  }, []);
}

export default function RequestWorkflowProgress({
  stage,
}: {
  stage: RequestWorkflowStage;
}) {
  useWorkflowFillAnimation();

  return (
    <section className="rounded-2xl border border-slate-300 bg-white px-6 py-5 shadow-sm in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:shadow-lichen-card in-[.lichen-d3]:[&_.rwp-fill]:animate-none! in-[.lichen-d3]:[&_.rwp-pop]:animate-none!">
      {stage.terminalStatus ? (
        <div className="mb-5 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:rounded-lg">
          This request is {stage.terminalStatus}. Workflow progression has stopped.
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4 sm:gap-0">
        {WORKFLOW_STEPS.map((step, index) => {
          const achieved = index <= stage.stepIndex;
          const next =
            !stage.terminalStatus &&
            index === stage.stepIndex + 1 &&
            index < WORKFLOW_STEPS.length;
          const connectorAchieved = index < stage.stepIndex;
          const connectorNext =
            !stage.terminalStatus &&
            index === stage.stepIndex &&
            index < WORKFLOW_STEPS.length - 1;
          const isComplete = achieved && index < stage.stepIndex;
          const circle = achieved
            ? 'bg-emerald-500 text-white in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text in-[.lichen-d3]:ring-1 in-[.lichen-d3]:ring-mist-text'
            : next
              ? 'bg-[#137fec] text-white ring-4 ring-[#137fec]/15 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:text-primary-foreground in-[.lichen-d3]:ring-1 in-[.lichen-d3]:ring-lichen-icon'
              : 'bg-slate-100 text-slate-400 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-meta';
          const text = achieved ? 'text-slate-900 in-[.lichen-d3]:text-ink' : next ? 'text-[#137fec] in-[.lichen-d3]:text-lichen-text' : 'text-slate-400 in-[.lichen-d3]:text-meta';
          const showFill = connectorAchieved || connectorNext;

          return (
            <div key={step.key} className="relative flex items-center gap-3 sm:block">
              {index < WORKFLOW_STEPS.length - 1 ? (
                <div
                  aria-hidden="true"
                  className="absolute left-[15px] top-9 h-[calc(100%+0.75rem)] w-0.5 overflow-hidden bg-slate-200 sm:left-[calc(50%+16px)] sm:right-[calc(-50%+16px)] sm:top-[15px] sm:h-0.5 sm:w-auto"
                >
                  {showFill ? (
                    <div
                      className={`rwp-fill h-full w-full ${
                        connectorAchieved ? 'bg-emerald-500 in-[.lichen-d3]:bg-mist-text' : 'bg-[#137fec] in-[.lichen-d3]:bg-lichen-icon'
                      }`}
                      style={{ animationDelay: `${0.25 + index * 0.15}s` }}
                    />
                  ) : null}
                </div>
              ) : null}
              <div
                className={`rwp-pop relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold transition sm:mx-auto ${circle}`}
                style={{ animationDelay: `${index * 0.15}s` }}
              >
                {isComplete ? <Check className="h-4 w-4" /> : index + 1}
              </div>
              <div
                className={`relative z-10 mt-0 min-w-0 [overflow-wrap:anywhere] bg-white text-sm font-semibold sm:mx-1 sm:mt-2.5 sm:text-center in-[.lichen-d3]:bg-card ${text}`}
              >
                {step.label}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
