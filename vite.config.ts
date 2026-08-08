import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'mebelcenter-dev-route-redirects',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/') {
            res.statusCode = 302;
            res.setHeader('Location', '/app/');
            res.end();
            return;
          }
          if (req.url === '/missing-products') {
            res.statusCode = 302;
            res.setHeader('Location', '/app/missing-products');
            res.end();
            return;
          }
          if (req.url === '/dashboard' || req.url === '/inventory') {
            res.statusCode = 302;
            res.setHeader('Location', `/app${req.url}`);
            res.end();
            return;
          }
          next();
        });
      },
    },
  ],
  base: '/app/',
  publicDir: false,
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: 'public/app',
    emptyOutDir: true,
  },
});
