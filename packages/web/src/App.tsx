import { Suspense, lazy, useMemo } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DrawerHost } from "./components/DrawerHost";
import { Header } from "./components/Header";
import { useShortcuts } from "./lib/keys";
import { Board } from "./routes/Board";
import { ProjectView } from "./routes/ProjectView";
import { Projects } from "./routes/Projects";
import { SessionList } from "./routes/SessionList";
import { Layout } from "./routes/Layout";
import { Settings } from "./routes/Settings";
import { useUi } from "./store/ui";

/**
 * /dev/cards bundles contract fixtures, so the production build must not contain it. Both flags
 * are replaced at build time, which lets the bundler drop the dynamic import entirely.
 */
const DevCards =
  import.meta.env.DEV || import.meta.env.VITE_MOCK === "1"
    ? lazy(() => import("./routes/DevCards"))
    : null;

export function App() {
  const toggleTheme = useUi((s) => s.toggleTheme);
  const toggleCompact = useUi((s) => s.toggleCompact);
  const keys = useMemo(() => ({ t: toggleTheme, c: toggleCompact }), [toggleTheme, toggleCompact]);
  useShortcuts(keys);
  return (
    <div className="flex h-full flex-col">
      <Header />
      <main className="min-h-0 flex-1 overflow-auto">
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Navigate to="/board" replace />} />
            <Route path="/board" element={<Board />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:id" element={<ProjectView />} />
            <Route path="/sessions" element={<SessionList />} />
            <Route path="/layout" element={<Layout />} />
            <Route path="/settings" element={<Settings />} />
            {DevCards ? (
              <Route
                path="/dev/cards"
                element={
                  <Suspense fallback={<p className="p-s-4 text-fg-muted">Loading...</p>}>
                    <DevCards />
                  </Suspense>
                }
              />
            ) : null}
            <Route path="*" element={<Navigate to="/board" replace />} />
          </Routes>
        </ErrorBoundary>
      </main>
      <ConnectionBanner />
      <ErrorBoundary>
        <DrawerHost />
      </ErrorBoundary>
      <ErrorBoundary>
        <CommandPalette />
      </ErrorBoundary>
    </div>
  );
}
