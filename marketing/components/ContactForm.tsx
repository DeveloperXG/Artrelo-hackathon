'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { usePathname } from 'next/navigation';
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { SALES_EMAIL, API_BASE_URL } from '@/config/site';
import { track } from '@/lib/analytics';
import { forgetSubmission, rememberSubmission, wasRecentlySubmitted } from '@/lib/submissionMemory';

const portfolioSizes = ['1–10 units', '11–50 units', '51–250 units', '251–1,000 units', '1,000+ units'];

interface FormState {
  name: string;
  email: string;
  company: string;
  size: string;
  message: string;
  website: string; // honeypot — see the hidden field below
}

const emptyForm: FormState = { name: '', email: '', company: '', size: portfolioSizes[0], message: '', website: '' };

const fieldClass =
  'w-full rounded-xl border bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#137fec]/40 transition-all disabled:opacity-60';

// The contact form card. Client component: validates input, then POSTs to the
// Express API, which emails the sales alias with the sender set as Reply-To.
//
// This used to open a `mailto:` instead. That silently did nothing for any
// visitor without a registered mail handler — most desktop webmail users, and
// every in-app browser — while still showing a success screen, because JS
// cannot detect whether a mail client opened. Leads were lost with no signal.
export default function ContactForm() {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);

  // Recorded with the lead so /contact and /demo can be told apart without a
  // second endpoint. The backend cleans and length-caps it, and falls back to
  // "/contact" if it arrives empty.
  const pathname = usePathname();

  // "Started" means the visitor typed something, so it fires once per mount
  // rather than on every keystroke. The gap between this and _submitted is the
  // abandonment rate — the number that says whether the form is too long.
  const startedRef = useRef(false);

  // A reload after a successful send lands back on the confirmation rather than
  // an empty form. Read after mount, not during render: this page is statically
  // exported, so the server-rendered HTML can't know what's in storage.
  useEffect(() => {
    if (wasRecentlySubmitted('contact')) setStatus('sent');
  }, []);

  const startOver = () => {
    forgetSubmission('contact');
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
    if (!form.message.trim()) next.message = 'Please tell us a little about your needs.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (status === 'sending') return;
    setSendError(null);
    if (!validate()) return;

    setStatus('sending');
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/public/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, sourcePage: pathname }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        // Field-level errors come back keyed the same way the client keys them.
        if (data?.errors) setErrors(data.errors);
        setSendError(data?.message ?? 'Something went wrong. Please try again.');
        setStatus('idle');
        return;
      }
      // Only the fact of a submission and which page it came from. Never the
      // message body or the visitor's address — see lib/analytics.ts.
      track('demo_form_submitted', { source_page: pathname, portfolio_size: form.size });
      rememberSubmission('contact');
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
        <h3 className="text-lg font-bold text-slate-900 mb-2">Thanks — your message is on its way</h3>
        <p className="text-slate-600 text-sm leading-relaxed max-w-sm">
          We&apos;ve received it and a specialist will reply within one business day.
        </p>
        {/* A deliberate second message, not a reload. The API still applies its
            cooldown and per-address limit to whatever is sent next. */}
        <button type="button" onClick={startOver} className="mt-6 text-sm font-semibold text-[#137fec] hover:underline">
          Send another message
        </button>
      </div>
    );
  }

  const sending = status === 'sending';

  return (
    <form onSubmit={onSubmit} noValidate className="feature-card rounded-2xl p-8 space-y-5">
      {/* Honeypot. Hidden from people, irresistible to bots — the API treats a
          filled `website` as spam and silently drops it. Not `type="hidden"`,
          which bots skip; off-screen with autocomplete and tab order disabled. */}
      <div aria-hidden="true" className="absolute w-px h-px -left-[9999px] overflow-hidden">
        <label htmlFor="website">Leave this field empty</label>
        <input id="website" type="text" tabIndex={-1} autoComplete="off" value={form.website} onChange={update('website')} />
      </div>

      <div>
        <label htmlFor="name" className="block text-sm font-medium text-slate-700 mb-1.5">Full name</label>
        <input id="name" type="text" value={form.name} onChange={update('name')} disabled={sending} className={`${fieldClass} ${errors.name ? 'border-red-400' : 'border-slate-200'}`} placeholder="Jane Doe" />
        {errors.name && <p className="text-red-500 text-xs mt-1.5">{errors.name}</p>}
      </div>
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1.5">Work email</label>
        <input id="email" type="email" value={form.email} onChange={update('email')} disabled={sending} className={`${fieldClass} ${errors.email ? 'border-red-400' : 'border-slate-200'}`} placeholder="jane@company.com" />
        {errors.email && <p className="text-red-500 text-xs mt-1.5">{errors.email}</p>}
      </div>
      <div>
        <label htmlFor="company" className="block text-sm font-medium text-slate-700 mb-1.5">Company</label>
        <input id="company" type="text" value={form.company} onChange={update('company')} disabled={sending} className={`${fieldClass} ${errors.company ? 'border-red-400' : 'border-slate-200'}`} placeholder="Acme Property Group" />
        {errors.company && <p className="text-red-500 text-xs mt-1.5">{errors.company}</p>}
      </div>
      <div>
        <label htmlFor="size" className="block text-sm font-medium text-slate-700 mb-1.5">Portfolio size</label>
        <select id="size" value={form.size} onChange={update('size')} disabled={sending} className={`${fieldClass} border-slate-200`}>
          {portfolioSizes.map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="message" className="block text-sm font-medium text-slate-700 mb-1.5">How can we help?</label>
        <textarea id="message" rows={4} value={form.message} onChange={update('message')} disabled={sending} maxLength={4000} className={`${fieldClass} resize-none ${errors.message ? 'border-red-400' : 'border-slate-200'}`} placeholder="Tell us about your maintenance workflow and what you'd like to automate." />
        {errors.message && <p className="text-red-500 text-xs mt-1.5">{errors.message}</p>}
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
        {sending ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}
