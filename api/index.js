import { handleDashboardRequest } from '../lib/dashboardApp.js';

export default async function handler(req, res) {
  try {
    await handleDashboardRequest(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}
