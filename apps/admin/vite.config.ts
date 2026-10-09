import { defineConfig } from '@vben/vite-config';

import ElementPlus from 'unplugin-element-plus/vite';

export default defineConfig(async () => {
  return {
    application: {},
    vite: {
      plugins: [
        ElementPlus({
          format: 'esm',
        }),
      ],
      server: {
        proxy: {
          '/api': {
            changeOrigin: true,
            // Both development and local preview use the real Go API.
            target: process.env.GONGDAN_API_TARGET || 'http://127.0.0.1:18080',
            ws: true,
          },
        },
      },
    },
  };
});
