'use strict';

const cheerio = require('cheerio');
const { fetchPage } = require('../utils/http');
const { normalizeUrl, safeOrigin } = require('../utils/helpers');
const {
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
} = require('./checks');
const { checkSitemap, checkRobots, checkLlms } = require('./external-checks');

async function analyzeUrl(rawUrl, emit) {
  const url = normalizeUrl(rawUrl);
  const result = {
    url: rawUrl,
    normalizedUrl: url,
    timestamp: new Date().toISOString(),
    error: null,
    checks: {},
  };

  // Fetch main page
  let page = await fetchPage(url);

  if (!page.ok && url.startsWith('https://')) {
    const httpUrl = url.replace('https://', 'http://');
    emit({ type: 'log', url: rawUrl, message: '  → HTTPS falló, intentando HTTP…' });
    page = await fetchPage(httpUrl);
    if (page.ok) result.normalizedUrl = httpUrl;
  }

  const origin = safeOrigin(result.normalizedUrl);

  // On-page checks (only if page was fetched)
  if (!page.ok) {
    result.error = page.error;
    const failMsg = `URL inaccesible: ${page.error}`;
    emit({ type: 'check', url: rawUrl, check: 'connection', status: 'fail', message: failMsg });

    const checks = [
      'title',
      'metaDescription',
      'h1',
      'headingHierarchy',
      'emptyHeadings',
      'canonical',
      'imageAlts',
      'schema',
    ];

    for (const c of checks) {
      result.checks[c] = { status: 'fail', message: failMsg };
      emit({ type: 'check', url: rawUrl, check: c, status: 'fail', message: failMsg });
    }
  } else {
    const html = typeof page.data === 'string' ? page.data : '';
    const $ = cheerio.load(html);

    // 1. Title Tag
    result.checks.title = checkTitle($('title').first().text().trim());
    emit({ type: 'check', url: rawUrl, check: 'title', ...result.checks.title });

    // 2. Meta Description
    result.checks.metaDescription = checkMetaDescription(
      ($('meta[name="description"]').attr('content') ?? '').trim()
    );
    emit({ type: 'check', url: rawUrl, check: 'metaDescription', ...result.checks.metaDescription });

    // 3. H1 Tag
    const h1Texts = $('h1').map((_, el) => $(el).text().trim()).get();
    result.checks.h1 = checkH1(h1Texts);
    emit({ type: 'check', url: rawUrl, check: 'h1', ...result.checks.h1 });

    // 4-5. Heading hierarchy + empty headings
    const headings = extractHeadings($);
    result.checks.headingHierarchy = checkHeadingHierarchy(headings);
    emit({ type: 'check', url: rawUrl, check: 'headingHierarchy', ...result.checks.headingHierarchy });

    result.checks.emptyHeadings = checkEmptyHeadings(headings);
    emit({ type: 'check', url: rawUrl, check: 'emptyHeadings', ...result.checks.emptyHeadings });

    // 6. Canonical Tag
    result.checks.canonical = checkCanonical(
      ($('link[rel="canonical"]').attr('href') ?? '').trim(),
      url
    );
    emit({ type: 'check', url: rawUrl, check: 'canonical', ...result.checks.canonical });

    // 7. Image Alt Attributes
    result.checks.imageAlts = checkImageAlts(extractImages($));
    emit({ type: 'check', url: rawUrl, check: 'imageAlts', ...result.checks.imageAlts });

    // 8. Schema Markup
    result.checks.schema = checkSchema(extractSchema($));
    emit({ type: 'check', url: rawUrl, check: 'schema', ...result.checks.schema });
  }

  // External resource checks
  emit({ type: 'log', url: rawUrl, message: '  → Verificando sitemap…' });
  result.checks.sitemap = await checkSitemap(origin);
  emit({ type: 'check', url: rawUrl, check: 'sitemap', ...result.checks.sitemap });

  emit({ type: 'log', url: rawUrl, message: '  → Verificando robots.txt…' });
  result.checks.robots = await checkRobots(origin);
  emit({ type: 'check', url: rawUrl, check: 'robots', ...result.checks.robots });

  emit({ type: 'log', url: rawUrl, message: '  → Verificando llms.txt…' });
  result.checks.llms = await checkLlms(origin);
  emit({ type: 'check', url: rawUrl, check: 'llms', ...result.checks.llms });

  return result;
}

module.exports = { analyzeUrl };
