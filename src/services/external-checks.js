'use strict';

const { fetchPage } = require('../utils/http');

async function checkSitemap(origin) {
  const url = `${origin}/sitemap.xml`;
  const page = await fetchPage(url, 8000);
  
  if (!page.ok) {
    return { status: 'warning', message: 'Sitemap no encontrado en /sitemap.xml' };
  }
  
  if (page.status === 200 && page.data.includes('<urlset')) {
    return { status: 'pass', message: 'Sitemap.xml encontrado y válido' };
  }
  
  return { status: 'warning', message: 'Sitemap encontrado pero formato inválido' };
}

async function checkRobots(origin) {
  const url = `${origin}/robots.txt`;
  const page = await fetchPage(url, 8000);
  
  if (!page.ok) {
    return { status: 'warning', message: 'Robots.txt no encontrado' };
  }
  
  if (page.status === 200 && page.data.includes('User-agent')) {
    return { status: 'pass', message: 'Robots.txt encontrado y válido' };
  }
  
  return { status: 'warning', message: 'Robots.txt encontrado pero formato inválido' };
}

async function checkLlms(origin) {
  const url = `${origin}/llms.txt`;
  const page = await fetchPage(url, 8000);
  
  if (!page.ok || page.status !== 200) {
    return { status: 'info', message: 'LLMs.txt no encontrado (opcional para GEO)' };
  }
  
  return { status: 'pass', message: 'LLMs.txt encontrado (optimizado para IA)' };
}

module.exports = { checkSitemap, checkRobots, checkLlms };
