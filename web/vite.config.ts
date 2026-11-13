import { defineConfig, loadEnv } from "vite";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    server: {
      proxy: {
        "/api/v1": {
          target: env.CHAT_API_TARGET || "http://127.0.0.1:3000",
          changeOrigin: true,
          // Development only. Never inject a platform admin credential in production.
          ...(env.CHAT_DEV_TOKEN
            ? { headers: { authorization: `Bearer ${env.CHAT_DEV_TOKEN}` } }
            : {}),
        },
      },
    },
  };
});
