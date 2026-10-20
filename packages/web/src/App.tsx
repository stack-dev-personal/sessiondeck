import { useMemo } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { useShortcuts } from "./lib/keys";
import { Board } from "./routes/Board";
import { DevCards } from "./routes/DevCards";
import { Settings } from "./routes/Settings";
import { useUi } from "./store/ui";

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
          <Route path="/dev/cards" element={<DevCards />} />
          <Route path="*" element={<Navigate to="/board" replace />} />
        </Routes>
      </main>
    </div>
  );
}
