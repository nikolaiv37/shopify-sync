#!/usr/bin/env node

import 'dotenv/config';
import http from 'node:http';
import { handleDashboardRequest } from './lib/dashboardApp.js';

const PORT = Number.parseInt(process.env.DASHBOARD_PORT || '3000', 10);

const server = http.createServer((req, res) => {
  handleDashboardRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });
});

server.listen(PORT, () => {
  console.log(`Mebelcenter Operations listening on http://localhost:${PORT}`);
});
