// Browser tests (e2e/*.spec.mjs): headless Chromium and Firefox against the page served from
// this folder. Run: npm run test:e2e   (unit tests: npm run test:unit; both: npm test)
import { defineConfig, devices } from "@playwright/test";

const PORT = 8974;
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.mjs",
  // one at a time: in parallel, page loads time out on this machine (as in cutwist)
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 1200, height: 800 } },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1200, height: 800 } } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1200, height: 800 } } },
  ],
  webServer: {
    // threaded, HTTP/1.0, never cached: python3 -m http.server stalls the odd module request
    command: `python3 e2e/serve.py ${PORT} .`,
    url: `http://localhost:${PORT}/index.html`,
    // never reuse: a stray server on this port (another project) would get tested instead
    reuseExistingServer: false,
    stderr: "ignore",
  },
});
