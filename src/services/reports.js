'use strict';

function buildSummary(results) {
  const byCheck = {};
  
  for (const result of results) {
    for (const [check, data] of Object.entries(result.checks)) {
      if (!byCheck[check]) {
        byCheck[check] = { pass: 0, warning: 0, fail: 0, info: 0 };
      }
      byCheck[check][data.status] = (byCheck[check][data.status] || 0) + 1;
    }
  }
  
  return { byCheck };
}

function exportToCSV(results) {
  const checks = [
    'title',
    'metaDescription',
    'h1',
    'headingHierarchy',
    'emptyHeadings',
    'canonical',
    'imageAlts',
    'schema',
    'sitemap',
    'robots',
    'llms',
  ];
  
  const header = ['URL', ...checks.map((c) => `${c} Status`), ...checks.map((c) => `${c} Message`)];
  const rows = [header.join(',')];
  
  for (const result of results) {
    const row = [result.url];
    
    for (const check of checks) {
      const data = result.checks[check];
      row.push(data ? `"${data.status}"` : '"unknown"');
    }
    
    for (const check of checks) {
      const data = result.checks[check];
      row.push(data ? `"${data.message.replace(/"/g, '""')}"` : '"N/A"');
    }
    
    rows.push(row.join(','));
  }
  
  return rows.join('\n');
}

async function exportToPDF(results, stream) {
  const puppeteer = require('puppeteer');
  const summary = buildSummary(results);
  
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  try {
    const page = await browser.newPage();
    
    const html = generatePDFHTML(results, summary);
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
    });
    
    stream.end(pdf);
  } finally {
    await browser.close();
  }
}

function generatePDFHTML(results, summary) {
  const now = new Date().toLocaleString('es-AR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  
  const CHECK_LABELS = {
    title: 'Title Tag',
    metaDescription: 'Meta Description',
    h1: 'H1 Tag',
    headingHierarchy: 'Heading Hierarchy',
    emptyHeadings: 'Empty Headings',
    canonical: 'Canonical Tag',
    imageAlts: 'Image Alt Attrs',
    schema: 'Schema Markup',
    sitemap: 'Sitemap',
    robots: 'Robots.txt',
    llms: 'LLMs.txt',
  };
  
  const STATUS_COLORS = {
    pass: '#22c55e',
    warning: '#eab308',
    fail: '#ef4444',
    info: '#3b82f6',
  };
  
  const STATUS_ICONS = {
    pass: '✓',
    warning: '⚠',
    fail: '✗',
    info: 'ℹ',
  };
  
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 9px;
      line-height: 1.4;
      color: #0f172a;
    }
    
    .header {
      background: linear-gradient(135deg, #2563eb, #1e40af);
      color: white;
      padding: 20px;
      margin-bottom: 20px;
    }
    
    .header h1 {
      font-size: 18px;
      margin-bottom: 8px;
    }
    
    .header .meta {
      font-size: 8px;
      opacity: 0.9;
    }
    
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 20px;
    }
    
    .summary-card {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 12px;
      text-align: center;
    }
    
    .summary-card .num {
      font-size: 24px;
      font-weight: 800;
      line-height: 1;
      margin-bottom: 4px;
    }
    
    .summary-card .lbl {
      font-size: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #64748b;
      font-weight: 600;
    }
    
    .url-card {
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      margin-bottom: 12px;
      page-break-inside: avoid;
    }
    
    .url-card-header {
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      padding: 8px 12px;
      font-weight: 700;
      font-size: 10px;
      word-break: break-all;
    }
    
    .check-row {
      display: flex;
      align-items: center;
      padding: 6px 12px;
      border-bottom: 1px solid #f1f5f9;
      font-size: 9px;
    }
    
    .check-row:last-child {
      border-bottom: none;
    }
    
    .check-icon {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      margin-right: 10px;
      flex-shrink: 0;
    }
    
    .check-label {
      font-weight: 600;
      width: 120px;
      flex-shrink: 0;
    }
    
    .check-msg {
      flex: 1;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🔍 SEO / GEO Scanner — Reporte</h1>
    <div class="meta">
      Generado: ${now}<br>
      URLs analizadas: ${results.length}
    </div>
  </div>
  
  <div class="summary-grid">
    <div class="summary-card">
      <div class="num" style="color: #2563eb;">${results.length}</div>
      <div class="lbl">URLs</div>
    </div>
    <div class="summary-card">
      <div class="num" style="color: #22c55e;">${Object.values(summary.byCheck).reduce((a, c) => a + c.pass, 0)}</div>
      <div class="lbl">Pasaron</div>
    </div>
    <div class="summary-card">
      <div class="num" style="color: #eab308;">${Object.values(summary.byCheck).reduce((a, c) => a + c.warning, 0)}</div>
      <div class="lbl">Warnings</div>
    </div>
    <div class="summary-card">
      <div class="num" style="color: #ef4444;">${Object.values(summary.byCheck).reduce((a, c) => a + c.fail, 0)}</div>
      <div class="lbl">Fallaron</div>
    </div>
  </div>
  
  ${results
    .map(
      (result) => `
    <div class="url-card">
      <div class="url-card-header">${result.url}</div>
      ${Object.entries(result.checks)
        .map(([check, data]) => {
          const color = STATUS_COLORS[data.status] || '#94a3b8';
          const icon = STATUS_ICONS[data.status] || '?';
          return `
        <div class="check-row">
          <div class="check-icon" style="background: ${color}20; color: ${color};">
            ${icon}
          </div>
          <div class="check-label">${CHECK_LABELS[check] || check}</div>
          <div class="check-msg">${data.message}</div>
        </div>
      `;
        })
        .join('')}
    </div>
  `
    )
    .join('')}
</body>
</html>`;
}

module.exports = { buildSummary, exportToCSV, exportToPDF };
