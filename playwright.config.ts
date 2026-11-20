import { defineConfig } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
let executablePath = process.env.CHROME_PATH;
const cache = path.join(homedir(), 'Library/Caches/ms-playwright');
if (!executablePath && existsSync(cache)) {
  for (const entry of readdirSync(cache).reverse()) {
    const candidate = path.join(cache, entry, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(candidate)) { executablePath = candidate; break; }
  }
}
export default defineConfig({
  testDir: './scripts/browser', timeout: 60000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5178', viewport: { width: 1440, height: 1100 }, launchOptions: { executablePath } },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5178 --strictPort', url: 'http://127.0.0.1:5178', reuseExistingServer: false, timeout: 20000 },
});
