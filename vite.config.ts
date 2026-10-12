import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { savePlugin } from "./scripts/vite-save-plugin.ts";

// BASE_PATH is set by the Pages deploy workflow (e.g. "/perseus_map/"); "/" locally.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react(), savePlugin()],
});
