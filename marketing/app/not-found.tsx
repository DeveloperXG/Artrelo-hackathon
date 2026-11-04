import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <section className="relative bg-[#0b1219] overflow-hidden min-h-[70vh] flex items-center">
      <div className="absolute inset-0 hero-grid"></div>
      <div className="absolute inset-0 hero-glow"></div>
      <div className="relative z-10 max-w-2xl mx-auto text-center px-6 py-24">
        <p className="text-[#5ea8ff] text-sm font-semibold tracking-wide mb-4">404</p>
        <h1 className="text-white text-4xl md:text-6xl font-bold tracking-tight mb-5">
          This page went <span className="text-gradient-animated">off-grid.</span>
        </h1>
        <p className="text-slate-400 text-lg leading-relaxed mb-10">
          The page you&rsquo;re looking for doesn&rsquo;t exist or may have moved. Let&rsquo;s get you back on track.
        </p>
        <Link
          href="/"
          className="group inline-flex items-center justify-center gap-2 bg-[#137fec] text-white px-7 py-3.5 rounded-xl text-base font-semibold hover:bg-[#137fec]/90 transition-all shadow-lg shadow-[#137fec]/30 hover:-translate-y-0.5"
        >
          Back to home
          <ArrowRight className="w-[18px] h-[18px] group-hover:translate-x-0.5 transition-transform" />
        </Link>
      </div>
    </section>
  );
}
