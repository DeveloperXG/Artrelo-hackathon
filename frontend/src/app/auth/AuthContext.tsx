import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import {
  AUTH_SESSION_EXPIRED_EVENT,
  AuthAPI,
  clearStoredSession,
  getStoredUser,
  getToken,
  setToken,
  setStoredUser,
} from '../api/client';

export type UserRole = 'guest' | 'landlord' | 'property_manager' | 'admin' | 'tenant';

export interface AuthUser {
  /** The role profile's id: one account can hold a landlord and a tenant profile. */
  id: string;
  /** The sign-in account behind the profile. */
  accountId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  role: UserRole;
  name?: string; // backwards-compat for display
  companyName?: string;
}

interface AuthContextType {
  user: AuthUser | null;
  isAuthenticated: boolean;
  loading: boolean;
  loginLandlord: (email: string, password: string) => Promise<AuthUser>;
  loginTenant: (email: string, password: string) => Promise<AuthUser>;
  signupLandlord: (body: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    confirmPassword?: string;
    phone?: string;
    companyName?: string;
  }) => Promise<AuthUser>;
  setSession: (user: AuthUser, token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function normalize(raw: Record<string, unknown>): AuthUser {
  const role = (raw.role as UserRole) || 'tenant';
  const firstName = (raw.firstName as string) || '';
  const lastName = (raw.lastName as string) || '';
  return {
    id: (raw.id as string) || (raw._id as string) || '',
    accountId: (raw.accountId as string) || undefined,
    firstName,
    lastName,
    email: raw.email as string,
    role,
    name: [firstName, lastName].filter(Boolean).join(' ') || (raw.email as string),
    companyName: raw.companyName as string,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser<AuthUser>());
  const [loading, setLoading] = useState(() => Boolean(getStoredUser<AuthUser>() || getToken()));

  useEffect(() => {
    const expireSession = () => {
      clearStoredSession();
      setUser(null);
      setLoading(false);
    };

    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expireSession);

    const restoreSession = async () => {
      const hasSessionResidue = Boolean(getStoredUser<AuthUser>() || getToken());
      if (!hasSessionResidue) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const res = await AuthAPI.me();
        const u = (res as { user?: Record<string, unknown> }).user || res.data;
        if (!u) {
          expireSession();
          return;
        }
        const norm = normalize(u as Record<string, unknown>);
        setUser(norm);
        setStoredUser(norm);
      } catch {
        expireSession();
      } finally {
        setLoading(false);
      }
    };

    restoreSession();

    return () => window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expireSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSession = (u: AuthUser, token: string) => {
    setToken(token);
    setStoredUser(u);
    setUser(u);
  };

  const loginLandlord = async (email: string, password: string) => {
    const res = await AuthAPI.landlordLogin({ email, password });
    const u = normalize((res.user as Record<string, unknown>) || {});
    if (!res.token) throw new Error('Missing token in response');
    setSession(u, res.token);
    return u;
  };

  const loginTenant = async (email: string, password: string) => {
    const res = await AuthAPI.tenantLogin({ email, password });
    const u = normalize((res.user as Record<string, unknown>) || {});
    if (!res.token) throw new Error('Missing token in response');
    setSession(u, res.token);
    return u;
  };

  const signupLandlord = async (body: Parameters<AuthContextType['signupLandlord']>[0]) => {
    const res = await AuthAPI.landlordSignup(body as unknown as Record<string, unknown>);
    const u = normalize((res.user as Record<string, unknown>) || {});
    if (!res.token) throw new Error('Missing token in response');
    setSession(u, res.token);
    return u;
  };

  const logout = () => {
    clearStoredSession();
    setUser(null);
    AuthAPI.logout().catch(() => {});
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        loading,
        loginLandlord,
        loginTenant,
        signupLandlord,
        setSession,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
