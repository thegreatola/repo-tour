import { defineConfig } from "vite";

/** Where the site will live. Override with SITE_URL=https://example.com/ npm run build. */
const SITE_URL = process.env.SITE_URL ?? "https://thegreatola.github.io/repo-tour/";

export default defineConfig({
  base: "./",
  build: { target: "es2022", rollupOptions: { input: { main: "index.html", privacy: "privacy.html", notFound: "404.html" } } },
  worker: { format: "es" },
  plugins: [
    {
      name: "site-url",
      transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", SITE_URL),
    },
  ],
});
