import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card } from './ui/card';
import { Loader2, ArrowRight } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useNavigate } from 'react-router-dom';
import { AuthAPI } from '../api/client';
import { marketingUrl } from '../lib/marketingUrl';

export default function TenantSignup() {
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const [code, setCode] = useState('');
  const [signupToken, setSignupToken] = useState('');

  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
  });

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      const res = await AuthAPI.verifyInviteCode(code);
      if (res.signupToken) {
        setSignupToken(res.signupToken);
        setStep(2);
      } else {
        setError(res.message || 'Invalid invite code');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to verify code';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      setIsLoading(false);
      return;
    }
    try {
      const res = await AuthAPI.tenantSignup({ ...formData, signupToken });
      if (res.success && res.token && res.user) {
        const u = res.user as { id?: string; _id?: string; email: string; role: string };
        setSession(
          {
            id: u.id || u._id || '',
            email: u.email,
            role: 'tenant',
            firstName: formData.firstName,
            lastName: formData.lastName,
            name: `${formData.firstName} ${formData.lastName}`,
          },
          res.token
        );
        navigate('/portal');
      } else {
        setError(res.message || 'Signup failed');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create account';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0f14] p-4 relative">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(circle at center, rgba(19, 127, 236, 0.12) 0%, rgba(168, 85, 247, 0.08) 35%, transparent 70%)',
        }}
      />
      <Card className="w-full max-w-md p-8 shadow-2xl bg-white border-none rounded-3xl relative z-10">
        <h2 className="text-3xl font-bold mb-2 text-center bg-gradient-to-r from-[#137fec] to-[#a855f7] bg-clip-text text-transparent">
          {step === 1 ? 'Have an Invite?' : 'Join Artrelo'}
        </h2>
        <p className="text-center text-gray-500 mb-8">
          {step === 1 ? 'Enter the code your landlord shared' : 'Create your tenant account'}
        </p>

        {error && (
          <div data-testid="tenant-signup-error" className="bg-red-50 text-red-600 p-4 rounded-xl mb-6 text-sm border border-red-100">
            {error}
          </div>
        )}

        {step === 1 ? (
          <form onSubmit={handleVerifyCode} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="code" className="text-gray-700">Invite Code</Label>
              <Input
                data-testid="tenant-code-input"
                id="code"
                placeholder="Ex: 7KQ4M9XTRH"
                value={code}
                // Codes are 10 characters (backend/services/inviteCode). Keep
                // only letters and digits rather than capping the raw input: a
                // maxLength would truncate a pasted "7KQ4M-9XTRH" before the
                // hyphen could be dropped. Anything else the API canonicalises
                // too, and older 6-character codes still fit.
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 10))}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                required
                className="text-center text-xl sm:text-2xl tracking-widest uppercase py-6 border-gray-200 focus:border-[#137fec] focus:ring-[#137fec] rounded-xl"
              />
            </div>
            <Button
              data-testid="tenant-verify-btn"
              type="submit"
              className="w-full bg-gradient-to-r from-[#137fec] to-[#a855f7] text-white py-6 rounded-xl text-lg shadow-lg hover:shadow-xl"
              disabled={isLoading}
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : null}
              Verify Code <ArrowRight className="w-5 h-5 ml-2" />
            </Button>
            <Button variant="ghost" type="button" className="w-full" onClick={() => { window.location.href = marketingUrl('/'); }}>
              Cancel
            </Button>
          </form>
        ) : (
          <form onSubmit={handleSignup} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name</Label>
                <Input
                  data-testid="tenant-firstname-input"
                  id="firstName"
                  required
                  value={formData.firstName}
                  onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                  className="rounded-xl border-gray-200"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name</Label>
                <Input
                  data-testid="tenant-lastname-input"
                  id="lastName"
                  required
                  value={formData.lastName}
                  onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                  className="rounded-xl border-gray-200"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                data-testid="tenant-email-input"
                id="email"
                type="email"
                required
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className="rounded-xl border-gray-200"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Phone</Label>
              <Input
                data-testid="tenant-phone-input"
                id="phone"
                type="tel"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="rounded-xl border-gray-200"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                data-testid="tenant-password-input"
                id="password"
                type="password"
                required
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                className="rounded-xl border-gray-200"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm Password</Label>
              <Input
                data-testid="tenant-confirm-input"
                id="confirmPassword"
                type="password"
                required
                value={formData.confirmPassword}
                onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                className="rounded-xl border-gray-200"
              />
            </div>

            <Button
              data-testid="tenant-signup-submit-btn"
              type="submit"
              className="w-full bg-gradient-to-r from-[#137fec] to-[#a855f7] text-white py-6 rounded-xl text-lg shadow-lg hover:shadow-xl mt-4"
              disabled={isLoading}
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : null}
              Create Account
            </Button>
            <Button variant="ghost" type="button" className="w-full" onClick={() => setStep(1)}>
              Back
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}

