import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  // #region agent log
  fetch("http://127.0.0.1:7701/ingest/35369d23-7f37-4585-ac9a-076a3915746b", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "658713" },
    body: JSON.stringify({
      sessionId: "658713",
      runId: "vite-host-debug",
      hypothesisId: "M27",
      location: "vite.config.ts:5",
      message: "vite config loaded with explicit host binding",
      data: { host: "0.0.0.0", port: 5173 },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion

  return {
    server: {
      host: "0.0.0.0",
      port: 5173
    },
    plugins: [react()],
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts"
    }
  };
});
