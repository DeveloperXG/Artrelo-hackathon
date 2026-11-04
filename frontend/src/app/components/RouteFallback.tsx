// Shown while a lazily-loaded route chunk is in flight, and while AuthContext is
// still resolving the session.
//
// Both are the same moment from the user's side — we know where they are going
// and we are not there yet — so they share one appearance. Giving them separate
// treatments would make a single navigation visibly change style depending on
// which of the two happened to still be pending.
export default function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0f14] text-white">
      <div className="text-slate-400 text-sm">Loading…</div>
    </div>
  );
}
