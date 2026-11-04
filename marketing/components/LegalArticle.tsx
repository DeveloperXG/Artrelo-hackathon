import type { ReactNode } from 'react';

export interface LegalSection {
  id: string;
  heading: string;
  body: ReactNode;
}

interface LegalArticleProps {
  title: string;
  updated: string;
  intro?: ReactNode;
  sections: LegalSection[];
}

// Prose shell for legal pages (Privacy, Terms): compact dark hero + light article.
export default function LegalArticle({ title, updated, intro, sections }: LegalArticleProps) {
  return (
    <>
      <section className="relative bg-[#0b1219] overflow-hidden pt-32 pb-14">
        <div className="absolute inset-0 hero-grid"></div>
        <div className="absolute inset-0 hero-glow"></div>
        <div className="relative z-10 max-w-3xl mx-auto px-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[#5ea8ff] text-xs font-semibold tracking-wide mb-4">
            Legal
          </div>
          <h1 className="text-white text-4xl md:text-5xl font-bold tracking-tight mb-4">{title}</h1>
          <p className="text-slate-400 text-sm">Last updated: {updated}</p>
        </div>
      </section>
      <article className="bg-white">
        <div className="max-w-3xl mx-auto px-6 py-16">
          {intro && <div className="text-slate-600 leading-relaxed space-y-3 mb-12">{intro}</div>}
          {sections.map((section, i) => (
            <section key={section.id} id={section.id} className="mb-10 scroll-mt-24">
              <h2 className="text-xl font-bold text-slate-900 mb-3">
                {i + 1}. {section.heading}
              </h2>
              <div className="text-slate-600 leading-relaxed space-y-3">{section.body}</div>
            </section>
          ))}
        </div>
      </article>
    </>
  );
}
