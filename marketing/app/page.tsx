import type { Metadata } from 'next';
import Link from 'next/link';
import {
  MessageSquare,
  Route,
  CheckCircle2,
  Bot,
  ArrowRight,
  ShieldCheck,
  Clock,
  Sparkles,
  Wrench,
  TrendingUp,
  Activity,
  Gauge,
  CalendarClock,
} from 'lucide-react';
import MarketingCta from '@/components/MarketingCta';
import RevealInit from '@/components/RevealInit';
import JsonLd from '@/components/JsonLd';
import ControlsSection from '@/components/ControlsSection';
import HowItWorksSteps from '@/components/HowItWorksSteps';
import CompletionProofSection from '@/components/CompletionProofSection';
import HomeFaq from '@/components/HomeFaq';
import { TENANT_SIGNUP_ENABLED } from '@/config/features';
import { appUrl } from '@/lib/appUrl';
import { ctaClass } from '@/lib/analytics';
import { SITE_URL, SITE_NAME } from '@/config/site';

export const metadata: Metadata = {
  description:
    'AI maintenance coordination for property managers. Artrelo runs tenant intake, triage, vendor routing, approvals and scheduling — and settles the vendor’s payment once the job is verified.',
  alternates: { canonical: '/' },
};

const softwareLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: SITE_NAME,
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web',
  url: SITE_URL,
  description:
    'AI maintenance coordination for property managers: tenant intake, triage, vendor routing, approval rules, scheduling, and verified vendor payment in one place.',
};

const chartBars = [42, 58, 38, 72, 50, 88, 60, 78, 46, 92, 66, 82];


// Truthful capability tiles — replaces the former fabricated metrics band.
const capabilities = [
  { value: 'Seconds', label: 'From tenant report to triaged request' },
  { value: 'Auto', label: 'Vendor matching by trade & availability' },
  { value: '1 tap', label: 'Approve & dispatch from anywhere' },
  { value: '24/7', label: 'Request intake, even overnight' },
];

export default function LandingPage() {
  return (
    <>
      <RevealInit />
      <JsonLd data={softwareLd} />

      {/* Hero */}
      <section className="relative bg-[#0b1219] flex flex-col items-center pt-36 pb-24 overflow-hidden">
        <div className="absolute inset-0 hero-grid"></div>
        <div className="absolute inset-0 hero-glow"></div>
        <div className="relative z-10 max-w-4xl mx-auto text-center px-6">
          <p className="text-[#5ea8ff] text-sm font-semibold tracking-wide mb-5">
            AI maintenance coordination for property managers
          </p>
          <h1 className="text-white text-5xl md:text-7xl font-bold leading-[1.05] tracking-tight mb-6">
            Maintenance on <span className="text-gradient-animated">autopilot.</span>
          </h1>
          {/* The span of the product, in the order it happens — and it ends at
              "paid", not at "dispatched", because that is the part competitors
              leave to you. */}
          <p className="text-slate-400 text-lg md:text-xl max-w-2xl mx-auto mb-10 leading-relaxed">
            Artrelo runs the work between a tenant&rsquo;s report and a finished repair — triage,
            vendor routing, approvals, scheduling, and settling the vendor&rsquo;s payment once the job is verified.
            You set the rules and handle the exceptions.
          </p>
          {/* Booking a demo is the conversion we can fulfil, so it is the primary
              and it is never gated: it is a marketing route, not a registration
              one. "Tenant: Enter Code" stays behind TENANT_SIGNUP_ENABLED and
              links into the SPA, so it keeps plain <a> + appUrl(). */}
          <div className="flex flex-col sm:flex-row justify-center gap-3.5">
            <Link
              href="/demo"
              data-testid="hero-demo-btn"
              className={`group inline-flex items-center justify-center gap-2 bg-[#137fec] text-white px-7 py-3.5 rounded-xl text-base font-semibold hover:bg-[#137fec]/90 transition-all shadow-lg shadow-[#137fec]/30 hover:shadow-xl hover:shadow-[#137fec]/40 hover:-translate-y-0.5 ${ctaClass('hero')}`}
            >
              Book a Demo
              <ArrowRight className="w-[18px] h-[18px] group-hover:translate-x-0.5 transition-transform" />
            </Link>
            {TENANT_SIGNUP_ENABLED && (
              <a
                href={appUrl('/signup')}
                data-testid="hero-enter-code-btn"
                className="inline-flex items-center justify-center gap-2 bg-white/[0.04] border border-white/10 text-white px-7 py-3.5 rounded-xl text-base font-semibold hover:bg-white/[0.08] transition-all hover:-translate-y-0.5"
              >
                Tenant: Enter Code
              </a>
            )}
          </div>
          {/* No response-time or duration promises here — only things that are
              true by construction of the product. */}
          <p className="mt-5 text-slate-500 text-sm">
            Your vendors · Your approval rules · No commitment
          </p>
        </div>

        {/* Product mockup */}
        <div className="relative z-10 mt-20 px-6 w-full max-w-5xl" data-reveal>
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-[#137fec] to-[#a855f7] rounded-2xl blur-lg opacity-25 group-hover:opacity-40 transition duration-700"></div>

            {/* Floating toast */}
            <div className="hidden sm:flex animate-float absolute -top-5 -right-4 z-20 items-center gap-2.5 bg-[#101b27] border border-white/10 rounded-xl px-4 py-2.5 shadow-2xl">
              <div className="w-7 h-7 rounded-lg bg-green-500/15 flex items-center justify-center">
                <CheckCircle2 className="w-4 h-4 text-green-400" />
              </div>
              <div className="text-left">
                <p className="text-white text-xs font-semibold leading-none">Plumber dispatched</p>
                <p className="text-slate-500 text-[10px] mt-1 leading-none">ETA 2h · Auto-scheduled</p>
              </div>
            </div>

            <div className="relative bg-[#161f2a] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-white/[0.03]">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-500/40"></div>
                  <div className="w-3 h-3 rounded-full bg-yellow-500/40"></div>
                  <div className="w-3 h-3 rounded-full bg-green-500/40"></div>
                </div>
                <div className="mx-auto bg-white/[0.04] rounded-md px-3 py-1 text-[10px] text-slate-500 font-mono">artrelo.com/maintenance/triage</div>
              </div>

              <div className="relative p-5 md:p-7 bg-gradient-to-br from-[#101b27] to-[#0b1219]">
                <div className="absolute inset-0 panel-grid opacity-60"></div>
                <div className="relative">
                  <div className="flex items-center justify-between mb-5">
                    <div>
                      <p className="text-white font-semibold text-sm">Maintenance Triage</p>
                      <p className="text-slate-500 text-xs mt-0.5">Apt 4B · Riverside Apartments</p>
                    </div>
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#137fec]/10 border border-[#137fec]/20 text-[#137fec] text-[10px] font-bold uppercase tracking-wider">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#137fec] animate-pulse"></span>
                      AI Active
                    </div>
                  </div>

                  <div className="grid md:grid-cols-5 gap-4">
                    {/* AI card */}
                    <div className="md:col-span-3 bg-white/[0.03] border border-white/10 rounded-xl p-5">
                      <div className="flex items-start gap-3 mb-4">
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#137fec] to-[#a855f7] flex items-center justify-center shrink-0">
                          <Bot className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-white">Artrelo Triage AI</p>
                          <p className="text-sm text-slate-400 leading-relaxed mt-1">
                            Diagnosed a leaking faucet from the tenant&apos;s photo. Flagged it as medium urgency and routed it to your preferred plumber — awaiting your approval.
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <div className="px-3 py-1.5 rounded-lg bg-[#137fec] text-white text-xs font-semibold">Approve &amp; Dispatch</div>
                        <div className="px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-slate-300 text-xs font-semibold">View Timeline</div>
                      </div>
                    </div>

                    {/* Right column */}
                    <div className="md:col-span-2 space-y-4">
                      <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-xs font-semibold text-white">Triage</p>
                          <Gauge className="w-4 h-4 text-slate-500" />
                        </div>
                        <div className="flex items-center justify-between text-[10px] mb-1.5">
                          <span className="text-slate-400">Urgency</span>
                          <span className="text-[#a855f7] font-bold">Medium</span>
                        </div>
                        <div className="h-2.5 rounded-full overflow-hidden bg-white/5 mb-3">
                          <div className="meter-fill h-full rounded-full bg-gradient-to-r from-[#137fec] to-[#a855f7]" style={{ width: '62%' }}></div>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-slate-500">
                          <span>Category · Plumbing</span>
                          <span>Routed</span>
                        </div>
                      </div>

                      <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 space-y-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-lg bg-[#137fec]/10 flex items-center justify-center shrink-0">
                            <Wrench className="w-3.5 h-3.5 text-[#137fec]" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-white font-medium truncate">Apt 9 · Clogged drain</p>
                            <p className="text-[10px] text-slate-500">Routing to vendor…</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-lg bg-[#a855f7]/10 flex items-center justify-center shrink-0">
                            <CalendarClock className="w-3.5 h-3.5 text-[#a855f7]" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-white font-medium truncate">Apt 2 · Light fixture</p>
                            <p className="text-[10px] text-slate-500">Scheduled · Tue 10am</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Capability strip (replaces the former "trusted by" logo bar) */}
      <div className="relative bg-gradient-to-b from-white to-slate-50 border-b border-slate-100 py-12">
        <div className="max-w-7xl mx-auto px-6">
          <p className="text-center text-slate-400 text-xs font-semibold uppercase tracking-[0.2em] mb-8">Every request handled end to end</p>
          <div className="flex flex-wrap justify-center items-center gap-x-8 gap-y-4 md:gap-x-12">
            {['AI intake', 'Urgency scoring', 'Vendor routing', 'Scheduling', 'Shared timeline'].map((cap) => (
              <div key={cap} className="inline-flex items-center gap-2 text-slate-600 font-semibold text-sm">
                <CheckCircle2 className="w-4 h-4 text-[#137fec] shrink-0" />
                {cap}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Capabilities band (replaces the former fabricated stats) */}
      <section className="relative bg-gradient-to-br from-[#137fec]/[0.04] via-white to-[#a855f7]/[0.05] overflow-hidden">
        <div className="absolute -top-24 left-1/4 w-72 h-72 bg-[#137fec]/10 rounded-full blur-3xl"></div>
        <div className="absolute -bottom-24 right-1/4 w-72 h-72 bg-[#a855f7]/10 rounded-full blur-3xl"></div>
        <div className="relative max-w-7xl mx-auto px-6 py-16">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-8 md:gap-4" data-reveal>
            {capabilities.map((item) => (
              <div key={item.label} className="text-center">
                <p className="text-3xl md:text-4xl font-bold tracking-tight text-gradient">{item.value}</p>
                <p className="mt-2 text-sm text-slate-500 font-medium">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="relative bg-white overflow-hidden scroll-mt-16">
        <div className="absolute inset-0 light-grid"></div>
        <div className="absolute -top-32 -left-32 w-96 h-96 bg-[#137fec]/[0.07] rounded-full blur-3xl"></div>
        <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-[#a855f7]/[0.07] rounded-full blur-3xl"></div>
        <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl mb-14" data-reveal>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#137fec]/[0.06] border border-[#137fec]/15 text-[#137fec] text-xs font-semibold tracking-wide mb-4">
              <Sparkles className="w-3.5 h-3.5" />
              Capabilities
            </div>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">Everything you need, handled intelligently</h2>
            <p className="text-slate-600 text-lg leading-relaxed">From the first tenant report to the final visit, Artrelo runs intake, triage, and routing end to end.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              { icon: MessageSquare, color: '#137fec', title: 'AI Request Intake', body: 'Tenants report issues in seconds via a guided AI chat. Artrelo gathers photos, details, and context automatically.' },
              { icon: Gauge, color: '#a855f7', title: 'Triage & Urgency Detection', body: 'AI determines the likely category, assesses urgency, and surfaces emergencies so critical work is prioritized instantly.' },
              { icon: Route, color: '#137fec', title: 'Vendor Routing', body: 'Every request is matched to the best-fit vendor by trade, location, and availability — no manual dispatching.' },
            ].map((f, i) => (
              <div key={f.title} className="feature-card p-7 rounded-2xl group" data-reveal style={{ transitionDelay: `${i * 90}ms` }}>
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center mb-5 group-hover:scale-110 group-hover:rotate-3 transition-transform"
                  style={{ backgroundColor: `${f.color}14`, color: f.color }}
                >
                  <f.icon className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold mb-2.5 text-slate-900">{f.title}</h3>
                <p className="text-slate-600 text-sm leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Showcase */}
      <section className="relative bg-slate-50 border-y border-slate-100 overflow-hidden">
        <div className="absolute top-1/2 -translate-y-1/2 -left-40 w-96 h-96 bg-[#137fec]/[0.08] rounded-full blur-3xl"></div>
        <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-24">
          <div className="flex flex-col md:flex-row items-center gap-12 lg:gap-20">
            <div className="w-full md:w-1/2" data-reveal>
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-5">Your portfolio, fully automated.</h2>
              <p className="text-slate-600 text-lg mb-8 leading-relaxed">
                Manage maintenance from a single command center. Whether you have 10 units or 10,000,
                Artrelo adapts to your workflow and handles the heavy lifting.
              </p>
              <ul className="space-y-4 mb-10">
                {['Autonomous request intake & triage', 'Instant vendor routing', 'Scheduling and a shared timeline'].map((item) => (
                  <li key={item} className="flex items-center gap-3 text-slate-700 font-medium">
                    <CheckCircle2 className="w-5 h-5 text-[#137fec] shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
              {/* This used to say "Explore the dashboard" and land on a sign-up
                  form — a promise the link did not keep. */}
              <Link
                href="/demo"
                className={`group inline-flex items-center gap-2 text-[#137fec] font-semibold hover:gap-3 transition-all ${ctaClass('showcase')}`}
              >
                See it on your portfolio
                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </div>

            {/* Dashboard mockup */}
            <div className="w-full md:w-1/2 relative" data-reveal>
              <div className="hidden sm:flex animate-float-slow absolute -bottom-5 -left-5 z-20 items-center gap-2.5 bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-xl">
                <div className="w-9 h-9 rounded-lg bg-green-500/10 flex items-center justify-center">
                  <TrendingUp className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="text-slate-900 text-sm font-bold leading-none">AI triage</p>
                  <p className="text-slate-500 text-[11px] mt-1 leading-none">on every request</p>
                </div>
              </div>

              <div className="relative rounded-2xl border border-slate-200 bg-white shadow-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-[#137fec]" />
                    <p className="font-semibold text-slate-900 text-sm">Maintenance Overview</p>
                  </div>
                  <div className="text-[11px] font-medium text-slate-500 px-2.5 py-1 rounded-md bg-slate-100">This week</div>
                </div>

                <div className="p-5">
                  <div className="grid grid-cols-3 gap-3 mb-6">
                    {[
                      { label: 'Open', value: '8', color: '#137fec' },
                      { label: 'In Progress', value: '5', color: '#a855f7' },
                      { label: 'Resolved', value: '42', color: '#16a34a' },
                    ].map((t) => (
                      <div key={t.label} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                        <p className="text-2xl font-bold tracking-tight" style={{ color: t.color }}>{t.value}</p>
                        <p className="text-[11px] text-slate-500 font-medium mt-0.5">{t.label}</p>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-end gap-1.5 h-28 mb-6" data-reveal>
                    {chartBars.map((h, i) => (
                      <div
                        key={i}
                        className="chart-bar flex-1 rounded-t-md bg-gradient-to-t from-[#137fec] to-[#a855f7]"
                        style={{ height: `${h}%`, transitionDelay: `${i * 55}ms` }}
                      ></div>
                    ))}
                  </div>

                  <div className="space-y-2">
                    {[
                      { unit: 'Apt 4B', issue: 'Leaking faucet', status: 'Awaiting Approval', color: '#a855f7' },
                      { unit: 'Apt 12', issue: 'No hot water', status: 'Scheduled', color: '#137fec' },
                      { unit: 'Apt 7C', issue: 'AC repair', status: 'Resolved', color: '#16a34a' },
                    ].map((row) => (
                      <div key={row.unit} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2.5">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                            <Wrench className="w-3.5 h-3.5 text-slate-500" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-900">{row.unit}</p>
                            <p className="text-[11px] text-slate-500 truncate">{row.issue}</p>
                          </div>
                        </div>
                        <span
                          className="text-[10px] font-bold px-2 py-1 rounded-full shrink-0"
                          style={{ backgroundColor: `${row.color}14`, color: row.color }}
                        >
                          {row.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="relative bg-[#0b1219] overflow-hidden scroll-mt-16">
        <div className="absolute inset-0 panel-grid opacity-50"></div>
        <div className="absolute top-1/4 -right-40 w-[28rem] h-[28rem] bg-[#a855f7]/10 rounded-full blur-[120px]"></div>
        <div className="absolute bottom-1/4 -left-40 w-[28rem] h-[28rem] bg-[#137fec]/10 rounded-full blur-[120px]"></div>

        <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl mb-14" data-reveal>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[#5ea8ff] text-xs font-semibold tracking-wide mb-4">
              The Process
            </div>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-white mb-4">How it works</h2>
            <p className="text-slate-400 text-lg leading-relaxed">
              From the first report to final resolution, every request moves through six automated steps.
            </p>
          </div>

          <HowItWorksSteps />
        </div>
      </section>

      {/* Answers the "do I want AI running my maintenance?" objection right
          after the pipeline is explained, and before the payment story asks for
          more trust than that. */}
      <ControlsSection />

      <CompletionProofSection />

      {/* Reassurance */}
      <section className="relative bg-white overflow-hidden">
        <div className="absolute inset-0 light-grid"></div>
        <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl mx-auto text-center mb-14" data-reveal>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#137fec]/[0.06] border border-[#137fec]/15 text-[#137fec] text-xs font-semibold tracking-wide mb-4">
              <ShieldCheck className="w-3.5 h-3.5" />
              Why Artrelo
            </div>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">Built for peace of mind</h2>
            <p className="text-slate-600 text-lg leading-relaxed">
              Secure by design, running from day one, and working around the clock so you don&apos;t have to.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              { icon: ShieldCheck, title: 'Secure by design', body: 'Your data is encrypted in transit and at rest, with strict access controls. Your portfolio data stays private and protected.' },
              { icon: Clock, title: 'Import and go', body: 'Import your portfolio from a spreadsheet and let AI take over the maintenance queue. No integrations to build, no training required.' },
              { icon: Bot, title: 'Always-on automation', body: 'Round-the-clock intake, triage, and dispatch, even while you sleep. Emergencies never wait for business hours.' },
            ].map((item, i) => (
              <div key={item.title} className="feature-card p-8 rounded-2xl text-center" data-reveal style={{ transitionDelay: `${i * 90}ms` }}>
                <div className="w-14 h-14 mx-auto rounded-2xl bg-[#137fec]/[0.08] text-[#137fec] flex items-center justify-center mb-6">
                  <item.icon className="w-7 h-7" />
                </div>
                <h3 className="text-lg font-bold text-slate-900 mb-2.5">{item.title}</h3>
                <p className="text-slate-600 text-sm leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <HomeFaq />

      {/* CTA */}
      <MarketingCta
        heading={<>Ready to reclaim <span className="text-gradient-animated">your time?</span></>}
        body="Hand your maintenance queue to Artrelo — intake, triage, and dispatch handled automatically while you stay in control."
      />
    </>
  );
}
