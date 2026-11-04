'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { usePathname } from 'next/navigation';
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { SALES_EMAIL, API_BASE_URL } from '@/config/site';
import { track } from '@/lib/analytics';
import { forgetSubmission, rememberSubmission, wasRecentlySubmitted } from '@/lib/submissionMemory';

// The demo request form.
//
// DELIBERATELY HIGHER FRICTION than the contact form. The constraint on this
// business is not traffic, it is the number of demos a founder can personally
// run — so the job of this form is to sort, not to maximise submissions. The
// vendor-payments question does most of that work: an operator unwilling to move
// money through Artrelo should discover that here, not three calls in.
//
// It posts to the SAME endpoint as ContactForm and adds no backend surface. The
// qualifying answers are composed into `message`, because that is the field the
// Lead row already persists; `sourcePage` is what separates /demo from /contact
// in the data.

// MUST match PORTFOLIO_SIZES in backend/controllers/publicContact.controller.js.
// A value not on that list is coerced to "Not specified" server-side rather than
// rejected, so drift here degrades lead quality silently.
const portfolioSizes = ['1–10 units', '11–50 units', '51–250 units', '251–1,000 units', '1,000+ units'];

const vendorPaymentAnswers = [
  'Yes — having Artrelo pay vendors is part of what I want',
  'Maybe — I would want to understand how it works first',
  'No — I would keep paying vendors myself',
];

interface FormState {
  name: string;
  email: string;
  company: string;
  size: string;
  role: string;
  currentProcess: string;
  vendorPayments: string;
  website: string; // honeypot
}

const emptyForm: FormState = {
  name: '',
  email: '',
  company: '',
  size: portfolioSizes[0],
  role: '',
  currentProcess: '',
  vendorPayments: vendorPaymentAnswers[0],
  website: '',
};

const fieldClass =
  'w-full rounded-xl border bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#137fec]/40 transition-all disabled:opacity-60';

// The endpoint stores one free-text body, so the qualification is folded into it
// rather than dropped.
function composeMessage(form: FormState): string {
  return [
    'How they handle maintenance today:',
    form.currentProcess.trim(),
    '',
    `Role: ${form.role.trim() || 'Not specified'}`,
    `Vendor payments through Artrelo: ${form.vendorPayments}`,
  ].join('\n');
}

export default function DemoForm() {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);

  const pathname = usePathname();
  const startedRef = useRef(false);

  // A reload after a successful send lands back on the confirmation rather than
  // an empty form. Read after mount, not during render: this page is statically
  // exported, so the server-rendered HTML can't know what's in storage.
  useEffect(() => {
    if (wasRecentlySubmitted('demo')) setStatus('sent');
  }, []);

  const startOver = () => {
    forgetSubmission('demo');
    setForm(emptyForm);
    setErrors({});
    setSendError(null);
    startedRef.current = false;
    setStatus('idle');
  };

  const update =
    (field: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      if (!startedRef.current && field !== 'website') {
        startedRef.current = true;
        track('demo_form_started', { source_page: pathname });
      }
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    };

  const validate = () => {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) next.name = 'Please enter your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) next.email = 'Please enter a valid work email.';
    if (!form.company.trim()) next.company = 'Please enter your company.';
    if (!form.currentProcess.trim()) next.currentProcess = 'A sentence or two is plenty.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (status === 'sending') return; // duplicate-submit guard
    setSendError(null);
    if (!validate()) return;

    setStatus('sending');
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/public/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          company: form.company,
          size: form.size,
          message: composeMessage(form),
          website: form.website,
          sourcePage: pathname,
        }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        if (data?.errors) setErrors(data.errors);
        setSendError(data?.message ?? 'Something went wrong. Please try again.');
        setStatus('idle');
        return;
      }
      // Portfolio size is the one dimension worth segmenting the funnel by. No
      // free-text ever goes to analytics.
      track('demo_form_submitted', { source_page: pathname, portfolio_size: form.size });
      rememberSubmission('demo');
      setStatus('sent');
    } catch {
      setSendError('We could not reach our servers. Please check your connection and try again.');
      setStatus('idle');
    }
  };

  if (status === 'sent') {
    return (
      <div className="feature-card rounded-2xl p-8 text-center flex flex-col items-center justify-center h-full">
        <div className="w-14 h-14 rounded-2xl bg-green-500/10 text-green-600 flex items-center justify-center mb-5">
          <CheckCircle2 className="w-7 h-7" />
        </div>
        <h3 className="text-lg font-bold text-slate-900 mb-2">Got it — we&rsquo;ll be in touch</h3>
        <p className="text-slate-600 text-sm leading-relaxed max-w-sm">
          We&rsquo;ll read what you sent about your current process before we reply, so the walkthrough
          is about your workflow rather than a generic tour.
        </p>
        {/* A deliberate second request, not a reload. The API still applies its
            cooldown and per-address limit to whatever is sent next. */}
        <button type="button" onClick={startOver} className="mt-6 text-sm font-semibold text-[#137fec] hover:underline">
          Send another request
        </button>
      </div>
    );
  }

  const sending = status === 'sending';

  return (
    <form onSubmit={onSubmit} noValidate className="feature-card rounded-2xl p-8 space-y-5">
      {/* Honeypot — hidden from people, irresistible to bots. The API treats a
          filled `website` as spam and silently drops it. */}
      <div aria-hidden="true" className="absolute w-px h-px -left-[9999px] overflow-hidden">
        <label htmlFor="demo-website">Leave this field empty</label>
        <input
          id="demo-website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={form.website}
          onChange={update('website')}
        />
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <div>
          <label htmlFor="demo-name" className="block text-sm font-medium text-slate-700 mb-1.5">Full name</label>
          <input id="demo-name" type="text" autoComplete="name" value={form.name} onChange={update('name')} disabled={sending} className={`${fieldClass} ${errors.name ? 'border-red-400' : 'border-slate-200'}`} placeholder="Jane Doe" />
          {errors.name && <p className="text-red-500 text-xs mt-1.5">{errors.name}</p>}
        </div>
        <div>
          <label htmlFor="demo-role" className="block text-sm font-medium text-slate-700 mb-1.5">
            Role <span className="text-slate-400 font-normal">(optional)</span>
          </label>
          <input id="demo-role" type="text" autoComplete="organization-title" value={form.role} onChange={update('role')} disabled={sending} className={`${fieldClass} border-slate-200`} placeholder="Operations Manager" />
        </div>
      </div>

      <div>
        <label htmlFor="demo-email" className="block text-sm font-medium text-slate-700 mb-1.5">Work email</label>
        <input id="demo-email" type="email" autoComplete="email" value={form.email} onChange={update('email')} disabled={sending} className={`${fieldClass} ${errors.email ? 'border-red-400' : 'border-slate-200'}`} placeholder="jane@company.com" />
        {errors.email && <p className="text-red-500 text-xs mt-1.5">{errors.email}</p>}
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <div>
          <label htmlFor="demo-company" className="block text-sm font-medium text-slate-700 mb-1.5">Company</label>
          <input id="demo-company" type="text" autoComplete="organization" value={form.company} onChange={update('company')} disabled={sending} className={`${fieldClass} ${errors.company ? 'border-red-400' : 'border-slate-200'}`} placeholder="Parkview Property Group" />
          {errors.company && <p className="text-red-500 text-xs mt-1.5">{errors.company}</p>}
        </div>
        <div>
          <label htmlFor="demo-size" className="block text-sm font-medium text-slate-700 mb-1.5">Portfolio size</label>
          <select id="demo-size" value={form.size} onChange={update('size')} disabled={sending} className={`${fieldClass} border-slate-200`}>
            {portfolioSizes.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="demo-process" className="block text-sm font-medium text-slate-700 mb-1.5">
          How do you handle maintenance requests today?
        </label>
        <textarea id="demo-process" rows={4} value={form.currentProcess} onChange={update('currentProcess')} disabled={sending} maxLength={3000} className={`${fieldClass} resize-none ${errors.currentProcess ? 'border-red-400' : 'border-slate-200'}`} placeholder="Who takes the call, how vendors get chosen, who approves the spend, and where it usually stalls." />
        {errors.currentProcess && <p className="text-red-500 text-xs mt-1.5">{errors.currentProcess}</p>}
      </div>

      <div>
        <label htmlFor="demo-payments" className="block text-sm font-medium text-slate-700 mb-1.5">
          Would you route vendor payments through Artrelo?
        </label>
        <select id="demo-payments" value={form.vendorPayments} onChange={update('vendorPayments')} disabled={sending} className={`${fieldClass} border-slate-200`}>
          {vendorPaymentAnswers.map((answer) => (
            <option key={answer} value={answer}>{answer}</option>
          ))}
        </select>
        <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
          Artrelo pays your vendors once a job is verified, which means funding a balance. There is
          no wrong answer here — it just tells us what to show you.
        </p>
      </div>

      {sendError && (
        <div role="alert" className="flex gap-2.5 rounded-xl bg-red-50 border border-red-200 px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <p className="text-red-700 text-xs leading-relaxed">
            {sendError} You can also email us at{' '}
            <a href={`mailto:${SALES_EMAIL}`} className="font-semibold underline">{SALES_EMAIL}</a>.
          </p>
        </div>
      )}

      <button type="submit" disabled={sending} className="w-full bg-[#137fec] text-white px-6 py-3.5 rounded-xl text-sm font-semibold hover:bg-[#137fec]/90 transition-all shadow-lg shadow-[#137fec]/30 disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2">
        {sending && <Loader2 className="w-4 h-4 animate-spin" />}
        {sending ? 'Sending…' : 'Request a demo'}
      </button>
    </form>
  );
}
