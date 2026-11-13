// The page loads the shared cohesion library from the network, and module scripts run in
// document order, so a stalled fetch of it holds up the page's own code. Fetch each external
// file once into a disk cache, and skip web fonts, which only change how text looks.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CACHE = join(import.meta.dirname, "..", "node_modules", ".cache", "card-table-e2e");
mkdirSync(CACHE, { recursive: true });

export async function serveFromCache(route) {
  const url = route.request().url();
  if (/fonts\.(googleapis|gstatic)\.com/.test(url)) return route.abort();
  const file = join(CACHE, createHash("sha1").update(url).digest("hex"));
  if (existsSync(file)) {
    const { status, headers, body } = JSON.parse(readFileSync(file, "utf8"));
    return route.fulfill({ status, headers, body: Buffer.from(body, "base64") });
  }
  const res = await route.fetch();
  const body = await res.body();
  const headers = { "content-type": res.headers()["content-type"] || "application/octet-stream", "access-control-allow-origin": "*" };
  if (res.ok()) writeFileSync(file, JSON.stringify({ status: res.status(), headers, body: body.toString("base64") }));
  return route.fulfill({ status: res.status(), headers, body });
}
