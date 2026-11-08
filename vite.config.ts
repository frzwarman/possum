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
 build: {rollupOptions:{output:{manualChunks:{supabase:['@supabase/supabase-js']}}}}
})
