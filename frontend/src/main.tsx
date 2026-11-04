  import { createRoot } from "react-dom/client";
  import App from "./app/App.tsx";
  import { initMonitoring, reactErrorHandler } from "./app/lib/monitoring";
  import "./styles/index.css";

  // Before render, so an error during the first render is reported too.
  initMonitoring();

  // Only with monitoring on: replacing React's defaults also replaces its own
  // console reporting, which local development wants to keep.
  const reportErrors = import.meta.env.VITE_SENTRY_DSN
    ? {
        onUncaughtError: reactErrorHandler((error) => console.error(error)),
        onCaughtError: reactErrorHandler(),
        onRecoverableError: reactErrorHandler(),
      }
    : {};

  createRoot(document.getElementById("root")!, reportErrors).render(<App />);
