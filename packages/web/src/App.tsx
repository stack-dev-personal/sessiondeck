import { Suspense, lazy, useMemo } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { DrawerHost } from "./components/DrawerHost";
import { Header } from "./components/Header";
import { useShortcuts } from "./lib/keys";
import { Board } from "./routes/Board";
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
        <Routes>
          <Route path="/" element={<Navigate to="/board" replace />} />
          <Route path="/board" element={<Board />} />
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
      </main>
      <DrawerHost />
    </div>
  );
}
