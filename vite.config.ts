import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
export default defineConfig({
 plugins: [react(), tailwind(), VitePWA({
 registerType: 'prompt', includeAssets: ['icon.svg'],
 manifest: { name: 'Meja — Kasir restoran', short_name: 'Meja', description: 'Kasir, pesanan, dan stok restoran', theme_color: '#205c45', background_color: '#f6f5f0', display: 'standalone', start_url: '/', icons: [{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}] },
 workbox: { globPatterns: ['**/*.{js,css,html,svg,woff2}'], navigateFallback: '/index.html', cleanupOutdatedCaches: true }
 })],
 build: {rollupOptions:{output:{manualChunks:{supabase:['@supabase/supabase-js']}}}}
})
