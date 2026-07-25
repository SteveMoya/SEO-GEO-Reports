'use strict';

function checkTitle(title) {
  if (!title) {
    return { status: 'fail', message: 'No se encontró <title>' };
  }
  const len = title.length;
  if (len < 30) {
    return { status: 'warning', message: `Título muy corto (${len} chars). Ideal: 50-60` };
  }
  if (len > 60) {
    return { status: 'warning', message: `Título muy largo (${len} chars). Ideal: 50-60` };
  }
  return { status: 'pass', message: `Título óptimo (${len} chars)` };
}

function checkMetaDescription(desc) {
  if (!desc) {
    return { status: 'fail', message: 'No se encontró meta description' };
  }
  const len = desc.length;
  if (len < 120) {
    return { status: 'warning', message: `Meta description corta (${len} chars). Ideal: 150-160` };
  }
  if (len > 160) {
    return { status: 'warning', message: `Meta description larga (${len} chars). Ideal: 150-160` };
  }
  return { status: 'pass', message: `Meta description óptima (${len} chars)` };
}

function checkH1(h1Texts) {
  if (h1Texts.length === 0) {
    return { status: 'fail', message: 'No se encontró <h1>' };
  }
  if (h1Texts.length > 1) {
    return { status: 'warning', message: `Múltiples <h1> encontrados (${h1Texts.length}). Ideal: solo 1` };
  }
  return { status: 'pass', message: 'Un solo <h1> presente' };
}

function extractHeadings($) {
  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const level = parseInt(tag[1]);
    const text = $(el).text().trim();
    headings.push({ level, text, tag });
  });
  return headings;
}

function checkHeadingHierarchy(headings) {
  if (headings.length === 0) {
    return { status: 'info', message: 'No se encontraron headings' };
  }
  
  let prevLevel = 0;
  let skipped = false;
  
  for (const h of headings) {
    if (h.level > prevLevel + 1 && prevLevel > 0) {
      skipped = true;
      break;
    }
    prevLevel = h.level;
  }
  
  if (skipped) {
    return { status: 'warning', message: 'Jerarquía de headings saltada (ej: h2 → h4)' };
  }
  return { status: 'pass', message: 'Jerarquía de headings correcta' };
}

function checkEmptyHeadings(headings) {
  const empty = headings.filter((h) => !h.text);
  if (empty.length > 0) {
    return { status: 'warning', message: `${empty.length} heading(s) vacío(s) encontrado(s)` };
  }
  return { status: 'pass', message: 'Todos los headings tienen contenido' };
}

function checkCanonical(href, pageUrl) {
  if (!href) {
    return { status: 'warning', message: 'No se encontró canonical tag' };
  }
  if (href === pageUrl) {
    return { status: 'pass', message: 'Canonical apunta a la URL correcta' };
  }
  return { status: 'warning', message: `Canonical apunta a URL diferente` };
}

function extractImages($) {
  const images = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src');
    const alt = $(el).attr('alt');
    images.push({ src, alt });
  });
  return images;
}

function checkImageAlts(imgs) {
  if (imgs.length === 0) {
    return { status: 'info', message: 'No se encontraron imágenes' };
  }
  
  const withoutAlt = imgs.filter((img) => !img.alt || img.alt.trim() === '');
  if (withoutAlt.length === 0) {
    return { status: 'pass', message: `Todas las imágenes (${imgs.length}) tienen alt` };
  }
  
  const pct = Math.round((withoutAlt.length / imgs.length) * 100);
  return { status: 'warning', message: `${withoutAlt.length}/${imgs.length} imágenes sin alt (${pct}%)` };
}

function extractSchema($) {
  const schemas = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      schemas.push(data);
    } catch {
      // Invalid JSON
    }
  });
  return schemas;
}

function checkSchema(data) {
  if (data.length === 0) {
    return { status: 'warning', message: 'No se encontró Schema Markup (JSON-LD)' };
  }
  return { status: 'pass', message: `${data.length} bloque(s) de Schema Markup encontrado(s)` };
}

module.exports = {
  checkTitle,
  checkMetaDescription,
  checkH1,
  extractHeadings,
  checkHeadingHierarchy,
  checkEmptyHeadings,
  checkCanonical,
  extractImages,
  checkImageAlts,
  extractSchema,
  checkSchema,
};
