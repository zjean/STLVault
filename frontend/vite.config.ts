import path from "path";
import fs from "fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const pkgJson = JSON.parse(
    fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
  );
  const appVersion = pkgJson.version || "dev";
  const API_URL = "TERA_API_URL";
  // `npm run dev` proxies /api here; override with
  // VITE_DEV_API_TARGET=http://localhost:9000 npm run dev if the backend runs elsewhere.
  const devApiTarget = env.VITE_DEV_API_TARGET || "http://localhost:8000";
  return {
    base: "/",
    preview: {
      port: 5173,
      allowedHosts: ["TERA_APP_URL"],
    },
    server: {
      port: 5173,
      host: "0.0.0.0",
      proxy: {
        "/api": {
          target: devApiTarget,
          changeOrigin: true,
        },
      },
    },
    define: {
      "import.meta.env.VITE_APP_TAG": JSON.stringify(appVersion),
      "import.meta.env.VITE_API_URL": JSON.stringify(API_URL),
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
      },
    },
  };
});
