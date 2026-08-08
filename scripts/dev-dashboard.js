#!/usr/bin/env node

import { spawn } from 'node:child_process';

const children = [];

function start(label, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  children.push(child);

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });
  child.on('exit', (code, signal) => {
    if (signal || shuttingDown) return;
    console.error(`[${label}] exited with code ${code}`);
    shutdown(code || 1);
  });
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('api', 'node', ['dashboardServer.js']);
start('vite', 'npx', ['vite', '--host', '127.0.0.1']);
