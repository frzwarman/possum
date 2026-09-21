import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
export default defineConfig({
 plugins:[react()],
 test:{env:{NODE_ENV:'test'},environment:'jsdom',globals:true,setupFiles:['tests/setup.ts'],include:['tests/unit/**/*.test.{ts,tsx}'],restoreMocks:true}
})
