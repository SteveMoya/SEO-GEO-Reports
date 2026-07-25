'use strict';

const express = require('express');
const multer = require('multer');
const { analyzeUrl } = require('../services/analyzer');
const { exportToCSV, exportToPDF } = require('../services/reports');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (/\.(csv|txt)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Solo archivos .csv o .txt'), false);
  },
});

// In-memory stores
const eventBuffers = new Map();
const sseClients = new Map();
const scanData = new Map();

function emit(scanId, event) {
  const client = sseClients.get(scanId);
  if (client) {
    try {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (_) {}
  } else {
    const buf = eventBuffers.get(scanId);
    if (buf) buf.push(event);
  }
}

async function runScan(scanId) {
  const data = scanData.get(scanId);
  if (!data) return;

  const { urls } = data;
  emit(scanId, { type: 'start', total: urls.length, message: `Escaneando ${urls.length} URL(s)` });

  for (let i = 0; i < urls.length; i++) {
    const rawUrl = urls[i];
    const startMs = Date.now();

    emit(scanId, {
      type: 'url_start',
      url: rawUrl,
      current: i + 1,
      total: urls.length,
      message: `Escaneando: ${rawUrl}`,
    });

    const result = await analyzeUrl(rawUrl, (event) => emit(scanId, event));
    result.duration = Date.now() - startMs;
    data.results.push(result);

    emit(scanId, {
      type: 'url_done',
      url: rawUrl,
      current: i + 1,
      total: urls.length,
      duration: result.duration,
      result,
      message: `Completado: ${rawUrl} (${result.duration}ms)`,
    });
  }

  emit(scanId, {
    type: 'complete',
    total: urls.length,
    results: data.results,
    message: `Escaneo completado. ${urls.length} URLs procesadas.`,
  });
}

router.post('/scan', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

    const content = req.file.buffer.toString('utf-8');
    const urls = content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

    if (!urls.length) {
      return res.status(400).json({ error: 'El archivo no contiene URLs válidas.' });
    }

    const scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    eventBuffers.set(scanId, []);
    scanData.set(scanId, { urls, results: [] });

    res.json({ scanId, total: urls.length });

    setImmediate(() => runScan(scanId));
  });
});

router.post('/scan-url', (req, res) => {
  const { urls: raw } = req.body;

  if (!raw || !raw.trim()) {
    return res.status(400).json({ error: 'Al menos una URL es requerida.' });
  }

  const urls = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  if (!urls.length) {
    return res.status(400).json({ error: 'No se encontraron URLs válidas.' });
  }

  const scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  eventBuffers.set(scanId, []);
  scanData.set(scanId, { urls, results: [] });

  res.json({ scanId, total: urls.length });

  setImmediate(() => runScan(scanId));
});

router.get('/events/:scanId', (req, res) => {
  const { scanId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('data: {"type":"connected"}\n\n');
  sseClients.set(scanId, res);

  const buffer = eventBuffers.get(scanId) || [];
  for (const evt of buffer) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  eventBuffers.delete(scanId);

  const ka = setInterval(() => {
    try {
      res.write(':ka\n\n');
    } catch (_) {}
  }, 20000);

  req.on('close', () => {
    clearInterval(ka);
    sseClients.delete(scanId);
  });
});

router.get('/results/:scanId', async (req, res) => {
  const data = scanData.get(req.params.scanId);
  if (!data || !data.results.length) {
    return res.status(404).json({ error: 'Scan no encontrado o aún en progreso.' });
  }

  const fmt = (req.query.format || 'json').toLowerCase();
  const filename = `seo-report-${req.params.scanId}`;

  if (fmt === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(exportToCSV(data.results));
  }

  if (fmt === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    try {
      await exportToPDF(data.results, res);
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

module.exports = router;
