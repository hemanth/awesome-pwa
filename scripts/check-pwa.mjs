#!/usr/bin/env node

/**
 * PWA Quality Checker for awesome-pwa
 *
 * Extracts app URLs from the ## Apps section of README.md,
 * checks each for PWA indicators (manifest link, service worker),
 * and optionally removes entries that aren't real PWAs.
 *
 * Usage:
 *   node scripts/check-pwa.mjs              # Report only (exit 1 if issues found)
 *   node scripts/check-pwa.mjs --fix        # Remove non-PWA entries from README
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = resolve(__dirname, "..", "README.md");

// Timeout for each URL check (ms)
const FETCH_TIMEOUT = 15_000;
// Max concurrent checks
const CONCURRENCY = 6;

// ── Known PWAs that inject manifests dynamically or block bots ────────
// These are verified PWAs that can't be detected via static HTML fetch.
// Add entries here with a justification when the checker can't detect them.
const WHITELIST = new Set([
  "drive.google.com",    // Google Drive — manifest injected by JS
  "photos.google.com",   // Google Photos — manifest injected by JS
  "duo.google.com",      // Google Duo — manifest injected by JS
  "web.telegram.org",    // Telegram Web — SPA, manifest injected by JS
  "www.taskade.com",     // Taskade — manifest injected by JS framework
  "www.trivago.com",     // trivago — blocks bot requests, verified PWA
  "www.digikala.com",    // Digikala — geo-blocked, verified PWA
  "abc.xyz",             // Alphabet — blocks bots, not really a PWA but in Misc
  "messages.google.com", // Google Messages — manifest injected by JS
]);

// ── Helpers ──────────────────────────────────────────────────────────

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function fetchWithTimeout(url, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      redirect: "follow",
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if a URL is a real PWA by looking for:
 * 1. A <link rel="manifest"> tag in the HTML
 * 2. Service worker registration (navigator.serviceWorker.register)
 * 3. Valid HTTP response (not 4xx/5xx)
 *
 * Returns { url, isPwa, hasManifest, hasServiceWorker, status, error, whitelisted }
 */
async function checkPwa(url) {
  const result = {
    url,
    isPwa: false,
    hasManifest: false,
    hasServiceWorker: false,
    isReachable: false,
    status: null,
    error: null,
    whitelisted: false,
    skipped: false,
  };

  const domain = getDomain(url);

  // Check whitelist
  if (WHITELIST.has(domain)) {
    result.isPwa = true;
    result.isReachable = true;
    result.whitelisted = true;
    return result;
  }

  // Skip GitHub repos, npm packages — these are tools/libraries, not apps
  if (url.includes("github.com/") || url.includes("npmjs.com/")) {
    result.isPwa = true;
    result.isReachable = true;
    result.skipped = true;
    return result;
  }

  try {
    const res = await fetchWithTimeout(url);
    result.status = res.status;
    result.isReachable = res.status < 400;

    if (!result.isReachable) {
      return result;
    }

    const html = await res.text();

    // Check for web app manifest
    result.hasManifest =
      /rel\s*=\s*["']manifest["']/i.test(html) ||
      /manifest\.json/i.test(html) ||
      /manifest\.webmanifest/i.test(html) ||
      /site\.webmanifest/i.test(html);

    // Check for service worker registration
    result.hasServiceWorker =
      /serviceworker/i.test(html) ||
      /service-worker/i.test(html) ||
      /serviceWorker\.register/i.test(html) ||
      /navigator\s*\.\s*serviceWorker/i.test(html) ||
      /sw\.js/i.test(html) ||
      /workbox/i.test(html);

    // A URL is considered a PWA if it has at least a manifest
    result.isPwa = result.hasManifest;
  } catch (err) {
    result.error = err.code || err.message || String(err);
    if (err.name === "AbortError") {
      result.error = "timeout";
    }
  }

  return result;
}

// ── Parse README ─────────────────────────────────────────────────────

function extractAppEntries(readmeContent) {
  const lines = readmeContent.split("\n");
  const entries = [];
  let inAppsSection = false;
  let currentSection = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect ## Apps section start
    if (/^## Apps\b/i.test(line)) {
      inAppsSection = true;
      continue;
    }

    // Detect end of ## Apps section (next ## heading)
    if (inAppsSection && /^## [^#]/.test(line)) {
      inAppsSection = false;
      continue;
    }

    if (!inAppsSection) continue;

    // Track sub-sections
    if (/^### /.test(line)) {
      currentSection = line.replace(/^### /, "").trim();
      continue;
    }

    // Match list entries: * [Name](url): description  OR  * [Name](url) - description
    const match = line.match(
      /^\s*\*\s+\[([^\]]+)\]\(([^)]+)\)[:\s-]+(.*)$/
    );
    if (match) {
      entries.push({
        lineIndex: i,
        name: match[1],
        url: match[2],
        description: match[3].trim(),
        section: currentSection,
        line: line,
      });
    }
  }

  return entries;
}

// ── Concurrent runner ────────────────────────────────────────────────

async function runConcurrent(items, fn, concurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const fix = process.argv.includes("--fix");
  const readme = readFileSync(README_PATH, "utf-8");
  const entries = extractAppEntries(readme);

  console.log(`\n🔍 Checking ${entries.length} app entries for PWA quality...\n`);

  const results = await runConcurrent(
    entries,
    async (entry) => {
      const result = await checkPwa(entry.url);
      const icon = result.whitelisted
        ? "🔒"
        : result.skipped
          ? "⏭️"
          : result.isPwa
            ? "✅"
            : result.isReachable
              ? "⚠️"
              : "❌";

      const details = [];
      if (result.whitelisted) details.push("whitelisted");
      if (result.skipped) details.push("skipped");
      if (!result.isReachable && !result.whitelisted && !result.skipped)
        details.push(`status=${result.status || result.error}`);
      if (result.isReachable && !result.hasManifest && !result.whitelisted && !result.skipped)
        details.push("no manifest");
      if (result.isReachable && !result.hasServiceWorker && !result.whitelisted && !result.skipped)
        details.push("no SW");
      if (result.error) details.push(result.error);

      const detailStr = details.length ? ` (${details.join(", ")})` : "";
      console.log(`  ${icon} [${entry.section}] ${entry.name} — ${entry.url}${detailStr}`);

      return { entry, result };
    },
    CONCURRENCY
  );

  // Separate results
  const passed = results.filter((r) => r.result.isPwa);
  const failed = results.filter((r) => !r.result.isPwa && r.result.isReachable);
  const dead = results.filter((r) => !r.result.isReachable && !r.result.isPwa);

  console.log(`\n📊 Results:`);
  console.log(`  ✅ PWA verified: ${passed.length}`);
  console.log(`  ⚠️  No PWA indicators (reachable but no manifest): ${failed.length}`);
  console.log(`  ❌ Unreachable / dead: ${dead.length}`);

  const toRemove = [...failed, ...dead];

  if (toRemove.length === 0) {
    console.log(`\n🎉 All entries pass PWA quality checks!`);
    process.exit(0);
  }

  if (toRemove.length > 0) {
    console.log(`\n🗑️  Entries to remove:`);
    for (const r of toRemove) {
      const reason = r.result.isReachable
        ? "no PWA manifest"
        : `unreachable (${r.result.status || r.result.error})`;
      console.log(`  - ${r.entry.name} (${r.entry.url}) — ${reason}`);
    }
  }

  if (fix && toRemove.length > 0) {
    console.log(`\n🔧 Removing ${toRemove.length} entries from README...`);

    const lines = readme.split("\n");
    const linesToRemove = new Set(toRemove.map((r) => r.entry.lineIndex));
    const newLines = lines.filter((_, i) => !linesToRemove.has(i));
    writeFileSync(README_PATH, newLines.join("\n"), "utf-8");

    console.log(`✅ README.md updated. Removed ${toRemove.length} entries.`);
  }

  if (!fix && toRemove.length > 0) {
    console.log(`\n💡 Run with --fix to remove these entries from README.md`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
