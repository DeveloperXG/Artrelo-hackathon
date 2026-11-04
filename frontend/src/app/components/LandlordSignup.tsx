import { useState, useEffect } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import AstreloLogo from './AstreloLogo';
import { marketingUrl } from '../lib/marketingUrl';

export default function LandlordSignup() {
  const [showPassword, setShowPassword] = useState(false);
  const [windowHeight, setWindowHeight] = useState(window.innerHeight);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
    companyName: '',
    phone: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { signupLandlord } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const handleResize = () => setWindowHeight(window.innerHeight);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isShortScreen = windowHeight < 800;

  const onChange = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setLoading(true);
    try {
      await signupLandlord(form);
      navigate('/dashboard');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Signup failed';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`bg-[#0a0f14] text-slate-100 flex flex-col font-sans relative ${isShortScreen ? 'min-h-screen overflow-y-auto' : 'h-screen overflow-hidden'}`}>
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(circle at center, rgba(19, 127, 236, 0.12) 0%, rgba(168, 85, 247, 0.08) 35%, transparent 70%)',
        }}
      />

      <header className="px-8 py-6 flex justify-between items-center relative z-10 w-full shrink-0">
        {/* Full navigation to the marketing home (separate app served at "/"). */}
        <a href={marketingUrl('/')} className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <AstreloLogo className="w-8 h-8" />
          <span className="text-white text-xl font-bold tracking-tight">Artrelo</span>
        </a>
        <div>
          <span className="text-slate-400 text-sm">Already have an account?</span>
          <Link to="/login" className="text-white text-sm font-semibold ml-2 hover:text-[#137fec] transition-colors">
            Sign in
          </Link>
        </div>
      </header>

      <main className="flex-grow flex items-center justify-center px-6 relative z-10 w-full">
        <div className="w-full max-w-2xl">
          <div
            className="p-8 md:p-10 rounded-3xl shadow-2xl backdrop-blur-xl border border-white/10"
            style={{ background: 'rgba(18, 24, 31, 0.8)' }}
          >
            <div className="text-center mb-6">
              <h1 className="text-3xl font-bold text-white mb-2">Create your landlord account</h1>
              <p className="text-slate-400">Join the future of property maintenance automation.</p>
            </div>

            {error && (
              <div data-testid="signup-error" className="bg-red-500/10 text-red-300 p-3 rounded-xl mb-4 text-sm border border-red-500/30">
                {error}
              </div>
            )}

            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">First Name</label>
                  <input
                    data-testid="signup-firstname-input"
                    required
                    value={form.firstName}
                    onChange={(e) => onChange('firstName', e.target.value)}
                    className="w-full px-5 py-3 rounded-xl text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#137fec]/30 focus:border-[#137fec] border border-white/10 bg-white/[0.03] transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Last Name</label>
                  <input
                    data-testid="signup-lastname-input"
                    required
                    value={form.lastName}
                    onChange={(e) => onChange('lastName', e.target.value)}
                    className="w-full px-5 py-3 rounded-xl text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#137fec]/30 focus:border-[#137fec] border border-white/10 bg-white/[0.03] transition-all"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Email Address</label>
                <input
                  data-testid="signup-email-input"
                  required
                  type="email"
                  placeholder="john@example.com"
                  value={form.email}
                  onChange={(e) => onChange('email', e.target.value)}
                  className="w-full px-5 py-3 rounded-xl text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#137fec]/30 focus:border-[#137fec] border border-white/10 bg-white/[0.03] transition-all"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Company (optional)</label>
                  <input
                    data-testid="signup-company-input"
                    value={form.companyName}
                    onChange={(e) => onChange('companyName', e.target.value)}
                    className="w-full px-5 py-3 rounded-xl text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#137fec]/30 focus:border-[#137fec] border border-white/10 bg-white/[0.03] transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Phone (optional)</label>
                  <input
                    data-testid="signup-phone-input"
                    value={form.phone}
                    onChange={(e) => onChange('phone', e.target.value)}
                    className="w-full px-5 py-3 rounded-xl text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#137fec]/30 focus:border-[#137fec] border border-white/10 bg-white/[0.03] transition-all"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Password</label>
                <div className="relative">
                  <input
                    data-testid="signup-password-input"
                    required
                    type={showPassword ? 'text' : 'password'}
                    placeholder="At least 8 characters"
                    value={form.password}
                    onChange={(e) => onChange('password', e.target.value)}
                    className="w-full px-5 py-3 rounded-xl text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#137fec]/30 focus:border-[#137fec] border border-white/10 bg-white/[0.03] transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Confirm Password</label>
                <input
                  data-testid="signup-confirm-input"
                  required
                  type="password"
                  value={form.confirmPassword}
                  onChange={(e) => onChange('confirmPassword', e.target.value)}
                  className="w-full px-5 py-3 rounded-xl text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#137fec]/30 focus:border-[#137fec] border border-white/10 bg-white/[0.03] transition-all"
                />
              </div>

              <div className="pt-2">
                <button
                  data-testid="signup-submit-btn"
                  disabled={loading}
                  type="submit"
                  className="w-full py-3 rounded-xl text-white font-bold text-lg shadow-lg shadow-[#137fec]/20 hover:brightness-110 hover:-translate-y-[1px] active:translate-y-0 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  style={{ background: 'linear-gradient(135deg, #137fec 0%, #a855f7 100%)' }}
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
                  Create Account
                </button>
              </div>
            </form>

            <p className="mt-6 text-center text-slate-500 text-xs leading-relaxed">
              By creating an account, you agree to our Terms of Service and Privacy Policy.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

