import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { useBoard } from "./store/board";
import { applyTheme, useUi } from "./store/ui";
import "./styles/index.css";

applyTheme(useUi.getState().theme);

if (import.meta.env.VITE_MOCK === "1") {
  void import("./mock/start").then((m) => m.startMock(useBoard));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
