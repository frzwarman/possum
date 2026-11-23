import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
export default defineConfig({
 plugins: [react(), tailwind(), VitePWA({
 registerType: 'prompt', includeAssets: ['icon.svg'],
 manifest: { name: 'Takar — Setiap gram tercatat', short_name: 'Takar', description: 'Kasir, stasiun dapur dan bar, dan stok sampai ke gram', theme_color: '#1b1d21', background_color: '#f6f5f0', display: 'standalone', start_url: '/', icons: [{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}] },
 workbox: { globPatterns: ['**/*.{js,css,html,svg,woff2}'], navigateFallback: '/index.html', cleanupOutdatedCaches: true, runtimeCaching: [{ urlPattern: /^https:\/\/images\.unsplash\.com\//, handler: 'CacheFirst', options: { cacheName: 'photos', expiration: { maxEntries: 120, maxAgeSeconds: 2592000 } } }] }
 })],
 // Playwright's server pre-bundles into its own folder: a shared node_modules/.vite gets rewritten under a running
 // `pnpm dev`, whose open tab then fails with 500s on HMR ("Failed to reload ...").
 cacheDir: process.env.E2E ? 'node_modules/.vite-e2e' : undefined,
 build: {rollupOptions:{output:{manualChunks:{supabase:['@supabase/supabase-js']}}}}
})
