import Link from 'next/link';
import AstreloLogo from './AstreloLogo';
import SectionLink from './SectionLink';

// A link is either a plain page link ({ href }) or a section link that scrolls
// to an on-page section without adding a #fragment ({ path, section }).
type FooterLink =
  | { label: string; href: string }
  | { label: string; path: string; section: string };

const columns: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Features', path: '/', section: 'features' },
      { label: 'How it works', path: '/', section: 'how-it-works' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Book a Demo', href: '/demo' },
    ],
  },
  {
    title: 'Solutions',
    links: [
      // Property Managers has a page of its own; the other two are still
      // anchored sections on the /solutions hub.
      { label: 'Property Managers', href: '/solutions/property-managers' },
      { label: 'Independent Landlords', path: '/solutions', section: 'independent-landlords' },
      { label: 'Multi-Family', path: '/solutions', section: 'multi-family' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About Us', href: '/about' },
      { label: 'Contact', href: '/contact' },
    ],
  },
];

const linkClass = 'hover:text-[#137fec] transition-colors';

export default function MarketingFooter() {
  return (
    <footer className="bg-[#0b1219] border-t border-white/[0.06] pt-20 pb-10">
      <div className="max-w-7xl mx-auto px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 mb-16 text-slate-300">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2.5 mb-5">
              <AstreloLogo className="w-9 h-9" />
              <span className="text-white text-lg font-bold tracking-tight">Artrelo</span>
            </div>
            <p className="text-slate-500 text-sm leading-relaxed max-w-xs">
              The AI-first maintenance automation platform for professional landlords.
            </p>
          </div>
          {columns.map((col) => (
            <div key={col.title}>
              <h4 className="text-white font-semibold mb-5 text-sm">{col.title}</h4>
              <ul className="space-y-3 text-sm text-slate-500">
                {col.links.map((link) => (
                  <li key={link.label}>
                    {'href' in link ? (
                      <Link className={linkClass} href={link.href}>
                        {link.label}
                      </Link>
                    ) : (
                      <SectionLink className={linkClass} path={link.path} section={link.section}>
                        {link.label}
                      </SectionLink>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="pt-8 border-t border-white/[0.06] flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-slate-500">
          <p>© {new Date().getFullYear()} Artrelo Inc. All rights reserved.</p>
          <div className="flex flex-wrap justify-center gap-6 md:gap-8">
            <Link className={linkClass} href="/security">
              Security
            </Link>
            <Link className={linkClass} href="/privacy">
              Privacy Policy
            </Link>
            <Link className={linkClass} href="/terms">
              Terms of Service
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
