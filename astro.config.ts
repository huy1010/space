import mdx from '@astrojs/mdx'
import sitemap from '@astrojs/sitemap'
import vue from '@astrojs/vue'
import { defineConfig } from 'astro/config'
import rehypeSlug from 'rehype-slug'
import UnoCSS from 'unocss/astro'

export default defineConfig({
  site: 'https://huy1010.github.io',
  base: '/space',
  server: {
    port: 1977,
  },
  integrations: [
    mdx({
      rehypePlugins: [rehypeSlug],
    }),
    sitemap(),
    UnoCSS({
      injectReset: true,
    }),
    vue(),
  ],
  markdown: {
    rehypePlugins: [rehypeSlug],
    shikiConfig: {
      themes: {
        light: 'github-light-default',
        dark: 'github-dark-default',
      },
      wrap: true,
    },
  },
})
