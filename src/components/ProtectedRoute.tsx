import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function ProtectedRoute({ children }: { children: JSX.Element }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <p>Loading session...</p>;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}
