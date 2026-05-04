#!/usr/bin/env node
/**
 * Resolve B2BMarkt feed to a local XML file.
 *
 * Usage:
 *   node scripts/resolve_b2bmarkt_feed.js --feed=main
 *   node scripts/resolve_b2bmarkt_feed.js --feed=symetron
 *   node scripts/resolve_b2bmarkt_feed.js --xml=b2bmarkt_updated.xml
 *   node scripts/resolve_b2bmarkt_feed.js --feed=symetron --out=custom.xml
 *
 * Behavior:
 *   --xml: returns the given path as-is (existing behavior).
 *   --feed: loads config/b2bmarkt-feeds.json, reads URL from env var,
 *           downloads to localFile (or --out), or uses existing local file.
 *
 * Prints safe info only: feed name, env var name, output path, bytes.
 * Does NOT print full secret URL.
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- CLI ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    feed: null,
    xmlPath: null,
    outPath: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--feed=')) {
      opts.feed = a.slice('--feed='.length);
    } else if (a.startsWith('--xml=')) {
      opts.xmlPath = a.slice('--xml='.length);
    } else if (a.startsWith('--out=')) {
      opts.outPath = a.slice('--out='.length);
    }
  }

  return opts;
}

// ---------- Feed config ----------

async function loadFeedConfig() {
  const configPath = path.resolve(__dirname, '..', 'config', 'b2bmarkt-feeds.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Cannot load feed config: ${e.message}`);
  }
}

// ---------- Download ----------

async function downloadFeed(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading feed`);
  }
  const buf = await res.arrayBuffer();
  await fs.writeFile(destPath, Buffer.from(buf));
  return buf.byteLength;
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv);

  // Case 1: --xml provided directly
  if (opts.xmlPath) {
    const resolved = path.resolve(opts.xmlPath);
    try {
      await fs.access(resolved);
    } catch {
      console.error(`ERROR: XML file not found: ${resolved}`);
      process.exit(1);
    }
    console.log(`XML path (direct): ${resolved}`);
    process.stdout.write(resolved);
    return;
  }

  // Case 2: --feed provided
  if (!opts.feed) {
    console.error('ERROR: Provide --feed=main|symetron or --xml=path.xml');
    process.exit(1);
  }

  const feeds = await loadFeedConfig();
  const feedConfig = feeds[opts.feed];

  if (!feedConfig) {
    const known = Object.keys(feeds).join(', ');
    console.error(`ERROR: Unknown feed "${opts.feed}". Known feeds: ${known}`);
    process.exit(1);
  }

  const envVarName = feedConfig.env;
  const defaultLocalFile = feedConfig.localFile;
  const outPath = opts.outPath ? path.resolve(opts.outPath) : path.resolve(defaultLocalFile);

  const feedUrl = process.env[envVarName];

  if (feedUrl) {
    // Download from URL
    const maskedUrl = feedUrl.substring(0, 30) + '...';
    console.log(`Feed: ${opts.feed}`);
    console.log(`Env var: ${envVarName} (set)`);
    console.log(`URL: ${maskedUrl}`);
    console.log(`Downloading to: ${outPath}`);

    try {
      const bytes = await downloadFeed(feedUrl, outPath);
      console.log(`Downloaded: ${(bytes / 1024).toFixed(1)} KB`);
    } catch (e) {
      console.error(`ERROR: Download failed: ${e.message}`);
      process.exit(1);
    }
  } else {
    // No URL — check for existing local file
    try {
      await fs.access(outPath);
      const stat = await fs.stat(outPath);
      console.log(`Feed: ${opts.feed}`);
      console.log(`Env var: ${envVarName} (not set)`);
      console.log(`WARNING: ${envVarName} not set. Using existing local file: ${outPath}`);
      console.log(`File size: ${(stat.size / 1024).toFixed(1)} KB`);
    } catch {
      console.error(`ERROR: ${envVarName} not set and local file not found: ${outPath}`);
      console.error(`  Set ${envVarName} in .env or place the XML file at ${outPath}`);
      process.exit(1);
    }
  }

  console.log(`Resolved XML: ${outPath}`);
  process.stdout.write(outPath);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
