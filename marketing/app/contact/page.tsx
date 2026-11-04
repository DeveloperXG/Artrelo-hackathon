import type { Metadata } from 'next';
import Link from 'next/link';
import { Mail, Clock, Users, Sparkles } from 'lucide-react';
import RevealInit from '@/components/RevealInit';
import ContactForm from '@/components/ContactForm';
import { SALES_EMAIL } from '@/config/site';

// /demo is the commercial path. This page is what is left over: partnerships,
// press, support routing, and anything that is not a demo request.
export const metadata: Metadata = {
  title: 'Contact',
  description:
    'Get in touch with the Artrelo team — partnerships, press, support, or anything that is not a demo request.',
  alternates: { canonical: '/contact' },
};

const valueProps = [
  { icon: Users, title: 'Straight to the team', body: 'Artrelo is small. Whoever replies is someone who works on the product.' },
  { icon: Clock, title: 'Partnerships and press', body: 'Vendor networks, integrations, and anything media-related lands here.' },
  { icon: Sparkles, title: 'Looking for a demo?', body: 'The demo page asks a few questions first so the walkthrough is about your workflow.' },
];

export default function ContactPage() {
  return (
    <>
      <RevealInit />

      {/* Hero */}
      <section className="relative bg-[#0b1219] overflow-hidden pt-32 pb-16">
        <div className="absolute inset-0 hero-grid"></div>
        <div className="absolute inset-0 hero-glow"></div>
        <div className="relative z-10 max-w-3xl mx-auto text-center px-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[#5ea8ff] text-xs font-semibold tracking-wide mb-4">
            <Mail className="w-3.5 h-3.5" />
            Contact
          </div>
          <h1 className="text-white text-4xl md:text-6xl font-bold tracking-tight mb-5">
            Get in touch
          </h1>
          <p className="text-slate-400 text-lg leading-relaxed">
            Partnerships, press, support, or a question that does not fit anywhere else. If you want
            to see the product on your own workflow,{' '}
            <Link href="/demo" className="text-[#5ea8ff] font-semibold hover:underline">
              book a demo
            </Link>{' '}
            instead.
          </p>
        </div>
      </section>

      {/* Two-column */}
      <section className="relative bg-white overflow-hidden">
        <div className="absolute inset-0 light-grid"></div>
        <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-24">
          <div className="grid md:grid-cols-2 gap-12 lg:gap-16">
            {/* Value props */}
            <div data-reveal>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 mb-6">
                What to expect
              </h2>
              <div className="space-y-6 mb-10">
                {valueProps.map((prop) => (
                  <div key={prop.title} className="flex gap-4">
                    <div className="w-11 h-11 rounded-xl bg-[#137fec]/[0.08] text-[#137fec] flex items-center justify-center shrink-0">
                      <prop.icon className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-slate-900 mb-1">{prop.title}</h3>
                      <p className="text-slate-600 text-sm leading-relaxed">{prop.body}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-sm text-slate-500">
                Prefer email? Reach us directly at{' '}
                <a href={`mailto:${SALES_EMAIL}`} className="text-[#137fec] font-semibold hover:underline">
                  {SALES_EMAIL}
                </a>
                .
              </p>
            </div>

            {/* Form */}
            <div data-reveal>
              <ContactForm />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
