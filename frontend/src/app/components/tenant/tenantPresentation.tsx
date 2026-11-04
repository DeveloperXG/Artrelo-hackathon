import { createContext, useContext } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import LandlordPageHeader from '../landlord/LandlordPageHeader';
import './tenantPresentation.css';

// The shell owner supplies the authoritative route scope. This module never
// derives permissions or enables a route; shared consumers default to legacy.
const TenantPresentationContext = createContext(false);
export const useTenantPresentation = () => useContext(TenantPresentationContext);
export function TenantPresentationProvider({ active, children }: { active: boolean; children: ReactNode }) {
  return <TenantPresentationContext.Provider value={active}>{children}</TenantPresentationContext.Provider>;
}

const TENANT_CONTROLS = '[&_[data-slot=button]]:max-w-full [&_[data-slot=button]]:h-auto [&_[data-slot=button]]:min-h-9 [&_[data-slot=button]]:whitespace-normal [&_[data-slot=button]]:[overflow-wrap:anywhere] [&_[data-slot=button]]:rounded-md [&_:is(button,a,input,textarea,select,summary)]:focus-visible:outline-solid [&_:is(button,a,input,textarea,select,summary)]:focus-visible:outline-2 [&_:is(button,a,input,textarea,select,summary)]:focus-visible:outline-offset-2 [&_:is(button,a,input,textarea,select,summary)]:focus-visible:outline-ring [&_*]:motion-reduce:animate-none! [&_*]:motion-reduce:transition-none';
export const TENANT_PORTAL = `lichen lichen-light lichen-d5 font-sans text-ink ${TENANT_CONTROLS}`;
export const TENANT_FIELD = 'in-[.lichen-d5]:text-base in-[.lichen-d5]:rounded-md in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-input-background in-[.lichen-d5]:text-ink in-[.lichen-d5]:shadow-none in-[.lichen-d5]:placeholder:text-meta in-[.lichen-d5]:focus:border-control-border in-[.lichen-d5]:focus:ring-0 in-[.lichen-d5]:focus-visible:outline-solid in-[.lichen-d5]:focus-visible:outline-2 in-[.lichen-d5]:focus-visible:outline-offset-2 in-[.lichen-d5]:focus-visible:outline-ring in-[.lichen-d5]:aria-invalid:border-alert-text';
export const TENANT_PRIMARY = 'in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:shadow-none in-[.lichen-d5]:hover:bg-primary/90';

export function TenantPage({ children, className = '' }: { children: ReactNode; className?: string }) {
  const active = useTenantPresentation();
  return <div className={`${className} ${active ? `${TENANT_PORTAL} min-w-0` : ''}`.trim() || undefined}>{children}</div>;
}

export function TenantState({ children }: { children: ReactNode }) {
  const active = useTenantPresentation();
  return active ? <TenantPage>{children}</TenantPage> : children;
}

export function TenantPageHeader(props: ComponentProps<typeof LandlordPageHeader>) {
  const active = useTenantPresentation();
  if (!active) return <LandlordPageHeader {...props} />;
  const { title, description, icon: Icon, actions, titleTestId = 'dashboard-title' } = props;
  return <header className="mb-6 flex min-w-0 flex-wrap items-start justify-between gap-4">
    <div className="min-w-0 flex-1 basis-64 [overflow-wrap:anywhere]">
      {Icon ? <span className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md bg-chip text-chip-icon"><Icon className="h-[18px] w-[18px]" aria-hidden="true" /></span> : null}
      <h1 className="text-2xl font-semibold tracking-tight text-ink" data-testid={titleTestId}>{title}</h1>
      <p className="mt-1 text-sm leading-6 text-meta">{description}</p>
    </div>
    {actions ? <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div> : null}
  </header>;
}
