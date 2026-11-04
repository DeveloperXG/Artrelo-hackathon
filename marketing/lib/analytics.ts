// The one place the marketing site talks to an analytics vendor.
//
// Nothing else imports Plausible directly, so swapping vendors later means
// rewriting this file and nothing else.
//
// TWO WAYS TO RECORD AN EVENT, and the reason there are two:
//
//   * ctaClass() — CSS-class tagging, read by Plausible's tagged-events script.
//     Requires no JavaScript of our own, which means a CTA inside a server
//     component stays a server component. Almost everything on this site is a
//     link in static HTML, so this is the default.
//   * track() — an imperative call, for things a class cannot express: form
//     lifecycle events that fire on state changes rather than clicks.
//
// PAGEVIEWS ARE NOT HERE. Plausible records them automatically; adding a custom
// marketing_page_view event on top would double-count every visit.
//
// NEVER pass free-form visitor input (a message body, an email address) as a
// prop. Props are for low-cardinality dimensions — which CTA, which page.

type EventName = 'cta_click' | 'demo_form_started' | 'demo_form_submitted' | 'faq_expanded';

declare global {
  interface Window {
    plausible?: (name: string, options?: { props?: Record<string, string> }) => void;
  }
}

export function track(name: EventName, props?: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  // The init snippet in layout.tsx defines a queueing stub before the script
  // loads, so this is safe during hydration. If the script is blocked outright
  // the stub still absorbs the call and nothing throws.
  window.plausible?.(name, props ? { props } : undefined);
}

// Tagged-event class names for a CTA. `location` identifies WHERE on the site
// the click happened, which is the entire point — it is how "the hero CTA
// outperforms the footer one" becomes answerable.
//
// Plausible parses these from the class list, so values must not contain
// spaces: use short kebab-case tokens ('hero', 'nav', 'pricing-faq').
export function ctaClass(location: string): string {
  return `plausible-event-name=cta_click plausible-event-location=${location}`;
}

// Same mechanism, for the FAQ accordion. Applied to the <summary>.
export const FAQ_EVENT_CLASS = 'plausible-event-name=faq_expanded';
