import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { CreateAccountPage } from "./pages/CreateAccountPage";
import { HomePage } from "./pages/HomePage";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { PlaylistPage } from "./pages/PlaylistPage";
import { SearchResultsPage } from "./pages/SearchResultsPage";
import { SpotifyCallbackPage } from "./pages/SpotifyCallbackPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/create-account" element={<CreateAccountPage />} />
      <Route path="/auth/spotify/callback" element={<SpotifyCallbackPage />} />
      <Route path="/auth/spotify/call" element={<SpotifyCallbackPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/home" element={<HomePage />} />
        <Route path="/search" element={<SearchResultsPage />} />
        <Route path="/playlists/:playlistId" element={<PlaylistPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
