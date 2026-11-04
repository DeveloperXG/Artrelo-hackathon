import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';
import ExternalRedirect from '../components/ExternalRedirect';
import RouteFallback from '../components/RouteFallback';
import { SIGN_IN_ENABLED } from '../config/features';

interface ProtectedRouteProps {
  allowedRoles?: string[];
}

export const ProtectedRoute = ({ allowedRoles }: ProtectedRouteProps) => {
  const { user, isAuthenticated, loading } = useAuth();

  if (loading) {
    return <RouteFallback />;
  }

  if (!isAuthenticated) {
    // Sign-in, not sign-up, is what an unauthenticated visitor needs here — and
    // during the closed beta that gate is open while registration is not. Only
    // if sign-in is switched off too does /login stop existing, and then the
    // marketing site at "/" is the right place to land.
    return SIGN_IN_ENABLED ? <Navigate to="/login" replace /> : <ExternalRedirect to="/" />;
  }

  if (allowedRoles && user) {
    const role = user.role;
    // landlord/property_manager/admin all share the landlord dashboard
    const isLandlordLike = ['landlord', 'property_manager', 'admin'].includes(role);
    const matches =
      allowedRoles.includes(role) ||
      (allowedRoles.includes('landlord') && isLandlordLike);
    if (!matches) {
      return <Navigate to="/" replace />;
    }
  }

  return <Outlet />;
};
