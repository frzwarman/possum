import { defineConfig,devices } from '@playwright/test'
const port=4173,baseURL=`http://127.0.0.1:${port}`
export default defineConfig({
 testDir:'./tests/e2e', fullyParallel:true, forbidOnly:Boolean(process.env.CI), retries:process.env.CI?1:0, workers:process.env.CI?2:undefined, reporter:[['list']],
 expect:{timeout:7000}, timeout:60000,
 use:{baseURL,trace:'retain-on-failure',locale:'id-ID',timezoneId:'Asia/Jakarta'},
 // One browser; the responsive spec sets its own viewports per describe block.
 projects:[{name:'chromium',use:{...devices['Desktop Chrome'],viewport:{width:1440,height:900}}}],
 webServer:{command:`npx vite dev --port ${port} --strictPort`,url:baseURL,reuseExistingServer:!process.env.CI,timeout:120000}
})
