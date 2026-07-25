'use strict';

const axios = require('axios');
const https = require('https');

// Relaxed HTTPS agent — needed to scan sites with self-signed / expired certs
const relaxedAgent = new https.Agent({ rejectUnauthorized: false });

async function fetchPage(url, timeout = 12000) {
  try {
    const res = await axios.get(url, {
      timeout,
      maxRedirects: 5,
      httpsAgent: relaxedAgent,
      validateStatus: (s) => s < 600,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEO-GEO-Scanner/1.0)',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    return { ok: true, data: res.data, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
}

module.exports = { fetchPage };
