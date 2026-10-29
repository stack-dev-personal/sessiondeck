import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { startAlerts } from "./alerts/start";
import { setAtlasApiReady } from "./atlas/api";
import { App } from "./App";
import { startLive } from "./live/start";
import { useBoard } from "./store/board";
import { startSaved, useSaved } from "./store/saved";
import { applyTheme, useUi } from "./store/ui";
import "./styles/index.css";

applyTheme(useUi.getState().theme);

if (import.meta.env.VITE_MOCK === "1") {
  // Atlas calls wait for the mock module, which installs the in-memory atlas api.
  const mockLoaded = import("./mock/start").then((m) => m.startMock(useBoard));
  setAtlasApiReady(mockLoaded);
  // e2e drives connection states and sessions through the stores; mock builds only (constant-folded away otherwise).
  (window as unknown as { __sd: unknown }).__sd = { board: useBoard, ui: useUi };
} else {
  startLive(useBoard, useUi);
}

startAlerts(useBoard, useUi);
startSaved(useBoard, useUi, useSaved);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
