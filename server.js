'use strict';

const express = require('express');
const multer  = require('multer');
const axios   = require('axios');
const cheerio = require('cheerio');
const https   = require('https');
const path    = require('path');
const puppeteer = require('puppeteer');

const app  = express();
const PORT = 3000;

// ──────────────────────────────────────────────────────────────────────────────
// In-memory stores
// ──────────────────────────────────────────────────────────────────────────────
const eventBuffers = new Map(); // scanId → Event[]   (buffer before SSE connects)
const sseClients   = new Map(); // scanId → res
const scanData     = new Map(); // scanId → { urls, results }

// Relaxed HTTPS agent — needed to scan sites with self-signed / expired certs
const relaxedAgent = new https.Agent({ rejectUnauthorized: false });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (/\.(csv|txt)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Solo archivos .csv o .txt'), false);
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────────────────────

/** POST /api/scan — parse CSV, queue scan, return scanId */
app.post('/api/scan', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

    const content = req.file.buffer.toString('utf-8');
    const urls = content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    if (!urls.length) {
      return res.status(400).json({ error: 'El archivo no contiene URLs válidas.' });
    }

    const scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    eventBuffers.set(scanId, []);
    scanData.set(scanId, { urls, results: [] });

    res.json({ scanId, total: urls.length });

    // Start after the HTTP response is fully flushed
    setImmediate(() => runScan(scanId));
  });
});

/** POST /api/scan-url — scan one or more URLs (newline-separated) */
app.post('/api/scan-url', (req, res) => {
  const { urls: raw } = req.body;

  if (!raw || !raw.trim()) {
    return res.status(400).json({ error: 'Al menos una URL es requerida.' });
  }

  const urls = raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  if (!urls.length) {
    return res.status(400).json({ error: 'No se encontraron URLs válidas.' });
  }

  const scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  eventBuffers.set(scanId, []);
  scanData.set(scanId, { urls, results: [] });

  res.json({ scanId, total: urls.length });

  setImmediate(() => runScan(scanId));
});

/** GET /api/events/:scanId — Server-Sent Events stream */
app.get('/api/events/:scanId', (req, res) => {
  const { scanId } = req.params;

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('data: {"type":"connected"}\n\n');
  sseClients.set(scanId, res);

  // Flush buffered events (emitted before the client connected)
  const buffer = eventBuffers.get(scanId) || [];
  for (const evt of buffer) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  eventBuffers.delete(scanId);

  // Keep-alive heartbeat
  const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch (_) {} }, 20_000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(scanId); });
});

/** GET /api/results/:scanId?format=json|csv|pdf — download results */
app.get('/api/results/:scanId', async (req, res) => {
  const data = scanData.get(req.params.scanId);
  if (!data || !data.results.length) {
    return res.status(404).json({ error: 'Scan no encontrado o aún en progreso.' });
  }

  const fmt = (req.query.format || 'json').toLowerCase();
  const filename = `seo-report-${req.params.scanId}`;

  if (fmt === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(toCSV(data.results));
  }

  if (fmt === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    try {
      await toPDF(data.results, res);
    } catch (err) {
      console.error('Error generando PDF:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al generar PDF' });
      }
    }
    return;
  }

  res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
  res.json(data.results);
});

// ──────────────────────────────────────────────────────────────────────────────
// SSE + terminal helpers
// ──────────────────────────────────────────────────────────────────────────────
function emit(scanId, event) {
  const client = sseClients.get(scanId);
  if (client) {
    try { client.write(`data: ${JSON.stringify(event)}\n\n`); } catch (_) {}
  } else {
    const buf = eventBuffers.get(scanId);
    if (buf) buf.push(event);
  }
  logToTerminal(event);
}

const CHECK_LABELS = {
  title:            'Title Tag',
  metaDescription:  'Meta Description',
  h1:               'H1 Tag',
  headingHierarchy: 'Heading Hierarchy',
  emptyHeadings:    'Empty Headings',
  canonical:        'Canonical Tag',
  imageAlts:        'Image Alt Attrs',
  schema:           'Schema Markup',
  sitemap:          'Sitemap',
  robots:           'Robots.txt',
  llms:             'LLMs.txt',
};

function logToTerminal(event) {
  const ts = new Date().toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const SEP = '─'.repeat(62);

  switch (event.type) {
    case 'start':
      console.log(`\n[${ts}] ${'━'.repeat(62)}`);
      console.log(`[${ts}] 🚀  INICIANDO ESCANEO — ${event.total} URL(s)`);
      console.log(`[${ts}] ${'━'.repeat(62)}`);
      break;

    case 'url_start':
      console.log(`\n[${ts}] 📡  [${event.current}/${event.total}] ${event.url}`);
      console.log(`[${ts}] ${SEP}`);
      break;

    case 'check': {
      const icons = { pass: '✅', warning: '⚠️ ', fail: '❌', info: 'ℹ️ ' };
      const icon  = icons[event.status] ?? '   ';
      const label = (CHECK_LABELS[event.check] ?? event.check).padEnd(20);
      console.log(`[${ts}]   ${icon}  ${label}  ${event.message}`);
      break;
    }

    case 'url_done':
      console.log(`[${ts}]   ⏱   Completado en ${event.duration}ms`);
      break;

    case 'error':
      console.error(`[${ts}] 💥  ERROR: ${event.message}`);
      break;

    case 'complete':
      console.log(`\n[${ts}] ${'━'.repeat(62)}`);
      console.log(`[${ts}] 🏁  ESCANEO COMPLETADO — ${event.total} URLs procesadas`);
      console.log(`[${ts}] ${'━'.repeat(62)}\n`);
      break;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main scan orchestrator
// ──────────────────────────────────────────────────────────────────────────────
async function runScan(scanId) {
  const data = scanData.get(scanId);
  if (!data) return;

  const { urls } = data;
  emit(scanId, { type: 'start', total: urls.length, message: `Escaneando ${urls.length} URL(s)` });

  for (let i = 0; i < urls.length; i++) {
    const rawUrl = urls[i];
    const startMs = Date.now();

    emit(scanId, {
      type: 'url_start', url: rawUrl,
      current: i + 1, total: urls.length,
      message: `Escaneando: ${rawUrl}`,
    });

    const result  = await analyzeUrl(rawUrl, scanId);
    result.duration = Date.now() - startMs;
    data.results.push(result);

    emit(scanId, {
      type:     'url_done',
      url:      rawUrl,
      current:  i + 1,
      total:    urls.length,
      duration: result.duration,
      result,
      message:  `Completado: ${rawUrl} (${result.duration}ms)`,
    });
  }

  const summary = buildSummary(data.results);
  emit(scanId, {
    type:    'complete',
    total:   urls.length,
    results: data.results,
    summary,
    message: `Escaneo completado. ${urls.length} URLs procesadas.`,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// URL analyzer
// ──────────────────────────────────────────────────────────────────────────────
async function analyzeUrl(rawUrl, scanId) {
  const url    = normalizeUrl(rawUrl);
  const result = {
    url:           rawUrl,
    normalizedUrl: url,
    timestamp:     new Date().toISOString(),
    error:         null,
    checks:        {},
  };

  // ── Fetch main page ────────────────────────────────────────────────────────
  let page = await fetchPage(url);

  if (!page.ok && url.startsWith('https://')) {
    const httpUrl = url.replace('https://', 'http://');
    emit(scanId, { type: 'log', url: rawUrl, message: '  → HTTPS falló, intentando HTTP…' });
    page = await fetchPage(httpUrl);
    if (page.ok) result.normalizedUrl = httpUrl;
  }

  const origin = safeOrigin(result.normalizedUrl);

  // ── On-page checks (only if page was fetched) ──────────────────────────────
  if (!page.ok) {
    result.error = page.error;
    const failMsg = `URL inaccesible: ${page.error}`;
    emit(scanId, { type: 'check', url: rawUrl, check: 'connection', status: 'fail', message: failMsg });

    for (const c of ['title','metaDescription','h1','headingHierarchy','emptyHeadings','canonical','imageAlts','schema']) {
      result.checks[c] = { status: 'fail', message: failMsg };
      emit(scanId, { type: 'check', url: rawUrl, check: c, status: 'fail', message: failMsg });
    }
  } else {
    const html = typeof page.data === 'string' ? page.data : '';
    const $    = cheerio.load(html);

    // 1. Title Tag
    result.checks.title = checkTitle($('title').first().text().trim());
    emitCheck(scanId, rawUrl, 'title', result.checks.title);

    // 2. Meta Description
    result.checks.metaDescription = checkMetaDescription(
      ($('meta[name="description"]').attr('content') ?? '').trim()
    );
    emitCheck(scanId, rawUrl, 'metaDescription', result.checks.metaDescription);

    // 3. H1 Tag
    const h1Texts = $('h1').map((_, el) => $(el).text().trim()).get();
    result.checks.h1 = checkH1(h1Texts);
    emitCheck(scanId, rawUrl, 'h1', result.checks.h1);

    // 4–5. Heading hierarchy + empty headings
    const headings = extractHeadings($);
    result.checks.headingHierarchy = checkHeadingHierarchy(headings);
    emitCheck(scanId, rawUrl, 'headingHierarchy', result.checks.headingHierarchy);

    result.checks.emptyHeadings = checkEmptyHeadings(headings);
    emitCheck(scanId, rawUrl, 'emptyHeadings', result.checks.emptyHeadings);

    // 6. Canonical Tag
    result.checks.canonical = checkCanonical(
      ($('link[rel="canonical"]').attr('href') ?? '').trim(), url
    );
    emitCheck(scanId, rawUrl, 'canonical', result.checks.canonical);

    // 7. Image Alt Attributes
    result.checks.imageAlts = checkImageAlts(extractImages($));
    emitCheck(scanId, rawUrl, 'imageAlts', result.checks.imageAlts);

    // 8. Schema Markup
    result.checks.schema = checkSchema(extractSchema($));
    emitCheck(scanId, rawUrl, 'schema', result.checks.schema);
  }

  // ── External resource checks ───────────────────────────────────────────────

  // 9. Sitemap
  emit(scanId, { type: 'log', url: rawUrl, message: '  → Verificando sitemap…' });
  result.checks.sitemap = await checkSitemap(origin);
  emitCheck(scanId, rawUrl, 'sitemap', result.checks.sitemap);

  // 10. Robots.txt
  emit(scanId, { type: 'log', url: rawUrl, message: '  → Verificando robots.txt…' });
  result.checks.robots = await checkRobots(origin);
  emitCheck(scanId, rawUrl, 'robots', result.checks.robots);

  // 11. LLMs.txt  (GEO)
  emit(scanId, { type: 'log', url: rawUrl, message: '  → Verificando llms.txt…' });
  result.checks.llms = await checkLlms(origin);
  emitCheck(scanId, rawUrl, 'llms', result.checks.llms);

  return result;
}

function emitCheck(scanId, url, checkName, check) {
  emit(scanId, {
    type:    'check',
    url,
    check:   checkName,
    status:  check.status,
    message: check.message,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ──────────────────────────────────────────────────────────────────────────────
async function fetchPage(url, timeout = 12_000) {
  try {
    const res = await axios.get(url, {
      timeout,
      maxRedirects:   5,
      httpsAgent:     relaxedAgent,
      validateStatus: s => s < 600,
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; SEO-GEO-Scanner/1.0)',
        'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    return { ok: true, data: res.data, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Check functions
// ──────────────────────────────────────────────────────────────────────────────
function checkTitle(title) {
  if (!title)            return { status: 'fail',    value: '',    message: 'No se encontró el title tag' };
  if (title.length < 10) return { status: 'warning', value: title, message: `Title muy corto (${title.length} chars — mínimo: 10)` };
  if (title.length > 60) return { status: 'warning', value: title, message: `Title muy largo (${title.length} chars — máximo: 60)` };
  return { status: 'pass', value: title, message: `Title OK (${title.length} chars): "${trunc(title, 50)}"` };
}

function checkMetaDescription(desc) {
  if (!desc)            return { status: 'fail',    value: '',   message: 'No se encontró meta description' };
  if (desc.length < 50) return { status: 'warning', value: desc, message: `Meta description muy corta (${desc.length} chars — mínimo: 50)` };
  if (desc.length > 160)return { status: 'warning', value: desc, message: `Meta description muy larga (${desc.length} chars — máximo: 160)` };
  return { status: 'pass', value: desc, message: `Meta description OK (${desc.length} chars)` };
}

function checkH1(texts) {
  const filled = texts.filter(Boolean);
  if (!filled.length)   return { status: 'fail',    value: [],    message: 'No se encontró ningún H1' };
  if (filled.length > 1)return { status: 'warning', value: filled, message: `Múltiples H1 (${filled.length}) — se recomienda solo uno` };
  return { status: 'pass', value: filled, message: `H1 OK: "${trunc(filled[0], 60)}"` };
}

function extractHeadings($) {
  const list = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    list.push({ tag: el.tagName.toLowerCase(), level: +el.tagName[1], text: $(el).text().trim() });
  });
  return list;
}

function checkHeadingHierarchy(headings) {
  const issues = [];
  let prev = 0;
  for (const h of headings) {
    if (prev > 0 && h.level > prev + 1) issues.push(`H${prev}→H${h.level}`);
    prev = h.level;
  }
  return issues.length
    ? { status: 'warning', issues, total: headings.length, message: `${issues.length} salto(s) de jerarquía: ${issues.join(', ')}` }
    : { status: 'pass', issues: [], total: headings.length, message: `Jerarquía correcta (${headings.length} headings)` };
}

function checkEmptyHeadings(headings) {
  const empty = headings.filter(h => !h.text);
  return empty.length
    ? { status: 'warning', count: empty.length, tags: empty.map(h => `<${h.tag}>`), message: `${empty.length} heading(s) vacío(s): ${empty.map(h => `<${h.tag}>`).join(', ')}` }
    : { status: 'pass',    count: 0, message: 'No hay headings vacíos' };
}

function checkCanonical(href, pageUrl) {
  if (!href) return { status: 'warning', value: '', message: 'No se encontró canonical tag' };
  return { status: 'pass', value: href, message: `Canonical: ${trunc(href, 70)}` };
}

function extractImages($) {
  const imgs = [];
  $('img').each((_, el) => {
    imgs.push({ src: $(el).attr('src') ?? '', alt: $(el).attr('alt'), hasAlt: $(el).attr('alt') !== undefined });
  });
  return imgs;
}

function checkImageAlts(imgs) {
  const total   = imgs.length;
  if (!total) return { status: 'pass', total: 0, missing: 0, message: 'No hay imágenes en la página' };

  const missing = imgs.filter(i => !i.hasAlt);
  if (!missing.length) {
    const emptyCount = imgs.filter(i => i.hasAlt && i.alt === '').length;
    return {
      status: 'pass', total, missing: 0, empty: emptyCount,
      message: `Todas las imágenes tienen alt (${total} imgs)${emptyCount ? `, ${emptyCount} decorativas con alt=""` : ''}`,
    };
  }
  const pct = Math.round(missing.length / total * 100);
  return {
    status:   missing.length > total * 0.2 ? 'fail' : 'warning',
    total, missing: missing.length,
    examples: missing.slice(0, 3).map(i => i.src),
    message:  `${missing.length}/${total} imágenes sin atributo alt (${pct}%)`,
  };
}

function extractSchema($) {
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html() ?? '');
      const arr    = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) jsonLd.push(item['@type'] ?? 'Unknown');
    } catch { jsonLd.push('JSON inválido'); }
  });
  return {
    jsonLd,
    microdata:   $('[itemscope]').length,
    openGraph:   $('meta[property^="og:"]').length,
    twitterCard: $('meta[name^="twitter:"]').length,
  };
}

function checkSchema(data) {
  const parts = [];
  if (data.jsonLd.length)    parts.push(`JSON-LD: ${data.jsonLd.join(', ')}`);
  if (data.microdata)        parts.push(`Microdata: ${data.microdata} elem.`);
  if (data.openGraph)        parts.push(`OpenGraph: ${data.openGraph} tags`);
  if (data.twitterCard)      parts.push(`Twitter Card: ${data.twitterCard} tags`);

  if (!data.jsonLd.length && !data.microdata) {
    return {
      status:  data.openGraph || data.twitterCard ? 'warning' : 'warning',
      ...data,
      message: parts.length ? `Solo social tags: ${parts.join(' | ')}` : 'No se encontró Schema markup (JSON-LD, Microdata, OpenGraph)',
    };
  }
  return { status: 'pass', ...data, message: parts.join(' | ') };
}

async function checkSitemap(origin) {
  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap/`,
  ];
  for (const url of candidates) {
    const r = await fetchPage(url, 8_000);
    if (r.ok && r.status === 200) {
      return { status: 'pass', url, message: `Sitemap encontrado: ${url}` };
    }
  }
  return { status: 'warning', url: `${origin}/sitemap.xml`, message: 'Sitemap no encontrado en ubicaciones estándar' };
}

async function checkRobots(origin) {
  const url = `${origin}/robots.txt`;
  const r   = await fetchPage(url, 8_000);
  if (!r.ok || r.status !== 200) {
    return { status: 'warning', url, message: 'robots.txt no encontrado' };
  }
  const content = typeof r.data === 'string' ? r.data : '';
  if (!content.toLowerCase().includes('user-agent')) {
    return { status: 'warning', url, message: 'robots.txt existe pero parece inválido (sin User-agent)' };
  }
  const hasSitemap  = /sitemap:/i.test(content);
  const hasDisallow = /disallow:/i.test(content);
  return {
    status: 'pass', url,
    hasSitemapDirective: hasSitemap, hasDisallow,
    message: `robots.txt OK${hasSitemap ? ' (con Sitemap)' : ' (sin directiva Sitemap)'}${!hasDisallow ? ' — sin Disallow' : ''}`,
  };
}

async function checkLlms(origin) {
  const url = `${origin}/llms.txt`;
  const r   = await fetchPage(url, 8_000);
  if (!r.ok || r.status !== 200) {
    return { status: 'info', url, message: 'llms.txt no encontrado — recomendado para GEO optimization' };
  }
  const lines = (typeof r.data === 'string' ? r.data : '').split('\n').filter(Boolean).length;
  return { status: 'pass', url, lineCount: lines, message: `llms.txt encontrado (${lines} líneas) — ✓ GEO ready` };
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary & export
// ──────────────────────────────────────────────────────────────────────────────
function buildSummary(results) {
  const checks = Object.keys(CHECK_LABELS);
  const byCheck = {};
  for (const c of checks) byCheck[c] = { pass: 0, warning: 0, fail: 0, info: 0 };

  for (const r of results) {
    for (const c of checks) {
      const s = r.checks[c]?.status;
      if (s && byCheck[c][s] !== undefined) byCheck[c][s]++;
    }
  }
  return { total: results.length, byCheck };
}

function toCSV(results) {
  const checks = Object.keys(CHECK_LABELS);
  const header = ['URL', 'Timestamp', 'Duration(ms)', 'Error',
    ...checks.flatMap(c => [`${c}_status`, `${c}_message`])];

  const rows = results.map(r => [
    r.url, r.timestamp, r.duration ?? '', r.error ?? '',
    ...checks.flatMap(c => {
      const ch = r.checks[c] ?? {};
      return [ch.status ?? 'n/a', (ch.message ?? '').replace(/,/g, ';').replace(/\n/g, ' ')];
    }),
  ]);

  return [header, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// PDF export — Puppeteer + HTML (Letter size: 8.5" × 11")
// Con header/footer fijos usando Puppeteer templates
// ──────────────────────────────────────────────────────────────────────────────
async function toPDF(results, stream) {
  const summary = buildSummary(results);
  const checks = Object.keys(CHECK_LABELS);
  const now = new Date().toLocaleString('es-AR', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  // ── Score calculator ────────────────────────────────────────────────────────
  function calcScore(checksObj) {
    let total = 0, max = checks.length * 2;
    for (const k of checks) {
      const s = checksObj[k]?.status;
      if (s === 'pass') total += 2;
      else if (s === 'warning' || s === 'info') total += 1;
    }
    return Math.round(total / max * 100);
  }

  // ── Status colors & icons ───────────────────────────────────────────────────
  const STATUS_COLORS = { pass: '#22c55e', warning: '#eab308', fail: '#ef4444', info: '#3b82f6' };
  const STATUS_BG     = { pass: 'rgba(34,197,94,.12)', warning: 'rgba(234,179,8,.12)', fail: 'rgba(239,68,68,.12)', info: 'rgba(59,130,246,.12)' };
  const STATUS_ICONS  = { pass: '✓', warning: '⚠', fail: '✗', info: 'ℹ' };

  // ── Build HTML ──────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

    * { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #ffffff;
      --surface:   #f8fafc;
      --card:      #ffffff;
      --border:    #e2e8f0;
      --primary:   #2563eb;
      --pass:      #22c55e;
      --warn:      #eab308;
      --fail:      #ef4444;
      --info:      #3b82f6;
      --text:      #0f172a;
      --muted:     #64748b;
      --font:      'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }

    @page {
      size: letter;
      margin: 0.6in 0.65in 0.5in 0.65in;
    }

    body {
      font-family: var(--font);
      font-size: 10px;
      line-height: 1.4;
      color: var(--text);
      background: var(--bg);
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ── Título de la primera página ───────────────────────────────────── */
    .report-title {
      background: #ffffff;
      border: 2px solid #0f172a;
      border-radius: 8px;
      padding: 20px 0.65in 18px;
      margin: -0.6in -0.65in 20px;
      position: relative;
    }
    .report-title-content { position: relative; z-index: 1; }
    .report-title h1 {
      font-size: 20px;
      font-weight: 800;
      color: #0f172a;
      margin-bottom: 6px;
    }
    .report-title p {
      font-size: 10px;
      color: #64748b;
    }
    .report-title .meta {
      display: flex;
      gap: 20px;
      margin-top: 12px;
      font-size: 8px;
      color: #64748b;
    }
    .report-title .meta span { display: flex; align-items: center; gap: 4px; }
    .report-title .dot { width: 5px; height: 5px; border-radius: 50%; background: #0f172a; }

    /* ── Section titles ─────────────────────────────────────────────────── */
    .section-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
      margin: 16px 0 8px;
      padding-bottom: 5px;
      border-bottom: 2px solid var(--primary);
      display: inline-block;
    }

    /* ── Summary cards ──────────────────────────────────────────────────── */
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-bottom: 14px;
    }
    .summary-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      text-align: center;
    }
    .summary-card .num {
      font-size: 22px;
      font-weight: 800;
      line-height: 1;
      margin-bottom: 2px;
    }
    .summary-card .lbl {
      font-size: 7px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      font-weight: 600;
    }
    .num-total { color: var(--primary); }
    .num-pass  { color: var(--pass); }
    .num-warn  { color: var(--warn); }
    .num-fail  { color: var(--fail); }

    /* ── Check summary table ────────────────────────────────────────────── */
    .check-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 8px;
      margin-bottom: 14px;
    }
    .check-table th {
      background: #0f172a;
      color: #e2e8f0;
      padding: 5px 8px;
      text-align: left;
      font-weight: 600;
      font-size: 7px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .check-table th:not(:first-child) { text-align: center; }
    .check-table td {
      padding: 4px 8px;
      border-bottom: 1px solid var(--border);
    }
    .check-table td:not(:first-child) { text-align: center; }
    .check-table tr:nth-child(even) { background: var(--surface); }
    .check-table tr:last-child td { border-bottom: none; }
    .check-name { font-weight: 600; color: var(--text); }

    /* ── Per-URL cards ──────────────────────────────────────────────────── */
    .url-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 10px;
      overflow: hidden;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .url-card-header {
      background: linear-gradient(90deg, #f0f9ff, #eff6ff);
      border-bottom: 1px solid var(--border);
      padding: 6px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .url-card-header .url {
      font-size: 9px;
      font-weight: 700;
      color: var(--primary);
      word-break: break-all;
    }
    .url-card-header .idx {
      font-size: 7px;
      color: var(--muted);
      font-weight: 600;
      background: var(--surface);
      padding: 2px 6px;
      border-radius: 10px;
    }
    .url-card-body { padding: 0; }
    .check-row {
      display: flex;
      align-items: center;
      padding: 4px 12px;
      font-size: 8px;
      border-bottom: 1px solid rgba(226,232,240,.5);
      min-height: 22px;
    }
    .check-row:last-child { border-bottom: none; }
    .check-row:nth-child(even) { background: rgba(248,250,252,.5); }
    .check-icon {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 700;
      margin-right: 8px;
      flex-shrink: 0;
    }
    .check-label {
      font-weight: 600;
      width: 90px;
      flex-shrink: 0;
      color: var(--text);
      font-size: 8px;
    }
    .check-msg {
      flex: 1;
      color: var(--muted);
      font-size: 7.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Score badge ────────────────────────────────────────────────────── */
    .score-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 9px;
      font-weight: 700;
    }
    .score-high   { background: rgba(34,197,94,.15); color: #16a34a; }
    .score-medium { background: rgba(234,179,8,.15);  color: #ca8a04; }
    .score-low    { background: rgba(239,68,68,.15);  color: #dc2626; }

    /* ── Error message ──────────────────────────────────────────────────── */
    .error-msg {
      background: rgba(239,68,68,.08);
      border-left: 3px solid var(--fail);
      padding: 5px 10px;
      font-size: 8px;
      color: var(--fail);
    }

    /* ── Evitar saltos de página dentro de cards ──────────────────────── */
    .avoid-break { break-inside: avoid; page-break-inside: avoid; }
  </style>
</head>
<body>

<!-- Título del reporte (solo primera página) -->
<div class="report-title">
  <div class="report-title-content">
    <h1>🔍 SEO / GEO Scanner — Reporte</h1>
    <p>Análisis completo de SEO técnico y optimización para buscadores de IA</p>
    <div class="meta">
      <span><span class="dot"></span> ${now}</span>
      <span>📊 ${results.length} URL(s) analizadas</span>
      <span>⏱️ ${results.reduce((acc, r) => acc + (r.duration || 0), 0)}ms total</span>
    </div>
  </div>
</div>

<!-- Contenido principal -->
<div class="main-content">

  <!-- Summary Cards -->
  <div class="section-title">📊 Resumen General</div>
  <div class="summary-grid">
    <div class="summary-card">
      <div class="num num-total">${results.length}</div>
      <div class="lbl">URLs Escaneadas</div>
    </div>
    <div class="summary-card">
      <div class="num num-pass">${Object.values(summary.byCheck).reduce((a, c) => a + c.pass, 0)}</div>
      <div class="lbl">Checks Pasados</div>
    </div>
    <div class="summary-card">
      <div class="num num-warn">${Object.values(summary.byCheck).reduce((a, c) => a + c.warning, 0)}</div>
      <div class="lbl">Advertencias</div>
    </div>
    <div class="summary-card">
      <div class="num num-fail">${Object.values(summary.byCheck).reduce((a, c) => a + c.fail, 0)}</div>
      <div class="lbl">Checks Fallidos</div>
    </div>
  </div>

  <!-- Check Summary Table -->
  <div class="section-title">📋 Resumen por Check</div>
  <table class="check-table">
    <thead>
      <tr>
        <th>Check</th>
        <th>✅ Pass</th>
        <th>⚠️ Warning</th>
        <th>❌ Fail</th>
        <th>ℹ️ Info</th>
      </tr>
    </thead>
    <tbody>
      ${checks.map(c => `
        <tr>
          <td class="check-name">${CHECK_LABELS[c]}</td>
          <td>${summary.byCheck[c].pass || 0}</td>
          <td>${summary.byCheck[c].warning || 0}</td>
          <td>${summary.byCheck[c].fail || 0}</td>
          <td>${summary.byCheck[c].info || 0}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <!-- Per-URL Results -->
  <div class="section-title">🌐 Resultados por URL</div>

  ${results.map((r, idx) => {
    const score = calcScore(r.checks);
    const scoreClass = score >= 80 ? 'score-high' : score >= 55 ? 'score-medium' : 'score-low';

    return `
      <div class="url-card avoid-break">
        <div class="url-card-header">
          <span class="url">${idx + 1}. ${r.url}</span>
          <span class="score-badge ${scoreClass}">${score}%</span>
        </div>
        <div class="url-card-body">
          ${r.error ? `<div class="error-msg">❌ Error: ${r.error}</div>` : ''}
          ${checks.map(c => {
            const ch = r.checks[c] ?? {};
            const st = ch.status ?? 'n/a';
            const color = STATUS_COLORS[st] ?? '#94a3b8';
            const bg = STATUS_BG[st] ?? 'rgba(148,163,184,.1)';
            const icon = STATUS_ICONS[st] ?? '·';
            const msg = ch.message ?? '—';
            return `
              <div class="check-row">
                <div class="check-icon" style="background:${bg};color:${color};">${icon}</div>
                <div class="check-label">${CHECK_LABELS[c]}</div>
                <div class="check-msg" title="${msg}">${msg}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }).join('')}

</div>

</body>
</html>`;

  // ── Generate PDF with Puppeteer ─────────────────────────────────────────────
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    await page.pdf({
      path: null,
      format: 'Letter',
      printBackground: true,
      margin: {
        top: '0.6in',
        right: '0.65in',
        bottom: '0.5in',
        left: '0.65in'
      },
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="font-size: 8px; font-family: Inter, Arial, sans-serif; color: #64748b; width: 100%; padding: 0 0.65in;">
          <span>SEO / GEO Scanner</span>
        </div>
      `,
      footerTemplate: `
        <div style="font-size: 7px; font-family: Inter, Arial, sans-serif; color: #64748b; width: 100%; padding: 0 0.65in;">
          <div style="border-top: 1px solid #e2e8f0; padding-top: 6px; display: flex; justify-content: space-between;">
            <span>Reporte SEO/GEO</span>
            <span>P&#225;gina <span class="pageNumber"></span> de <span class="totalPages"></span></span>
          </div>
        </div>
      `,
      preferCSSPageSize: true
    }).then(buffer => {
      stream.end(buffer);
    });
  } catch (err) {
    console.error('Error generando PDF:', err);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────────
function normalizeUrl(url) {
  url = url.trim();
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return url; }
}

function trunc(str, len) {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

// ──────────────────────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n${'━'.repeat(62)}`);
  console.log(`  🔍  SEO/GEO Scanner  →  http://localhost:${PORT}`);
  console.log(`  Subí tu archivo CSV (.csv/.txt, una URL por línea)`);
  console.log(`${'━'.repeat(62)}\n`);
});
