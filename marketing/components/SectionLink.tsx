'use client';

import { usePathname, useRouter } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';
import { SECTION_STORAGE_KEY, scrollToSection } from '@/lib/scrollToSection';

// A link to an on-page section that keeps the URL clean (no #fragment). If the
// section is on the current page, it scrolls straight to it; otherwise it stores
// the target and navigates, and RevealInit scrolls once the destination mounts.
export default function SectionLink({
  path,
  section,
  className,
  children,
  onNavigate,
}: {
  path: string;
  section: string;
  className?: string;
  children: ReactNode;
  // Fired only when this link actually navigates, so a container that needs to
  // react to that (the mobile menu closing itself) can. Deliberately not called
  // for modified clicks, which open a new tab and leave this page as it was.
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Let modified clicks (open in new tab/window) behave like a normal link.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate?.();
    if (pathname === path) {
      scrollToSection(section);
    } else {
      try {
        sessionStorage.setItem(SECTION_STORAGE_KEY, section);
      } catch {
        // sessionStorage unavailable (e.g. privacy mode) — navigate anyway.
      }
      // scroll:false disables the App Router's automatic scroll-to-top so it
      // doesn't override the scroll-to-section that RevealInit performs on the
      // destination page.
      router.push(path, { scroll: false });
    }
  };

  // href is the clean path (no hash); the click handler does the scrolling.
  return (
    <a href={path} onClick={handleClick} className={className}>
      {children}
    </a>
  );
}
