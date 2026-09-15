import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  publicDir: false,
  plugins: [react()],
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/release/**", "**/test-results/**"] } },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_*"],
});
