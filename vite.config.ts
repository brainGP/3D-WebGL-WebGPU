import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'three-core', test: /node_modules[\\/]three[\\/]build[\\/]three(?:\.core|\.module)\.js$/, priority: 25 },
            { name: 'charts-vendor', test: /node_modules[\\/]recharts[\\/]/, priority: 20 },
            { name: 'ui-vendor', test: /node_modules[\\/](?:@radix-ui|lucide-react|clsx|tailwind-merge|class-variance-authority)[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
});
