import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://plembfin.com",
  output: "static",
  build: {
    format: "directory",
  },
  integrations: [mdx(), sitemap()],
});
