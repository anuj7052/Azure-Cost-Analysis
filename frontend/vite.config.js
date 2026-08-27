import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        // The backend deliberately holds a cost request open for up to ~100s
        // while it waits out Azure throttling and gathers every subscription.
        // The proxy's default is shorter, so it was killing those requests and
        // handing the browser a 502 for a query that was still working. Both
        // values are set: `timeout` covers the incoming socket, `proxyTimeout`
        // the outgoing one, and leaving either at the default reintroduces the
        // failure from the other side.
        timeout: 180000,
        proxyTimeout: 180000,
      },
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {},
      },
    },
  },
})
