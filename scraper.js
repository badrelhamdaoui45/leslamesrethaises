const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Target domain details
const DOMAIN = 'www.federation-apcp.org';
const ALT_DOMAIN = 'federation-apcp.org';
const BASE_URL = `https://${DOMAIN}/`;

// Output directory (current workspace)
const OUTPUT_DIR = process.cwd();

// Queues and tracking sets
const pagesQueue = [BASE_URL];
const visitedPages = new Set([BASE_URL]);
const assetsQueue = new Map(); // URL -> localPath
const downloadedAssets = new Set();
const failedDownloads = new Set();

// Concurrency settings
const CONCURRENCY_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_ATTEMPTS = 3;

// Helper to wait
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Custom Task Queue for concurrent downloads
class TaskQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }
  
  add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.next();
    });
  }
  
  next() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const { task, resolve, reject } = this.queue.shift();
      this.running++;
      task()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          this.running--;
          this.next();
        });
    }
  }
}

const downloadQueue = new TaskQueue(CONCURRENCY_LIMIT);

/**
 * Fetch a URL with a timeout and retry mechanism.
 */
async function fetchWithTimeout(urlStr, options = {}) {
  const { timeout = REQUEST_TIMEOUT_MS, retries = RETRY_ATTEMPTS } = options;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(urlStr, {
        ...options,
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ...options.headers
        }
      });
      clearTimeout(timer);
      
      if (!response.ok) {
        throw new Error(`HTTP status ${response.status}`);
      }
      return response;
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[Fetch Warn] Failed to fetch ${urlStr} (Attempt ${attempt}/${retries}): ${err.message}`);
      if (attempt === retries) {
        throw err;
      }
      await delay(1000 * attempt); // exponential backoff
    }
  }
}

/**
 * Resolve relative or absolute URLs to absolute URLs.
 */
function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch (e) {
    return relative;
  }
}

/**
 * Check if a URL belongs to the target domain.
 */
function isInternalUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname === DOMAIN || parsed.hostname === ALT_DOMAIN;
  } catch (e) {
    return false;
  }
}

/**
 * Filter function to skip crawling dynamic calendar views or infinite loops.
 */
function shouldCrawlPage(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const pathname = parsed.pathname.toLowerCase();
    
    // Exclude events calendar dynamic listings/views
    if (pathname.includes('/evenements/etiquette/') ||
        pathname.includes('/evenements/jour/') ||
        pathname.includes('/evenements/liste/') ||
        pathname.includes('/evenements/carte/') ||
        pathname.includes('/evenements/mois/') ||
        pathname.includes('/evenements/photo/')) {
      return false;
    }
    
    // Exclude paths containing date patterns like /2025-10/ or /2026-04-03/
    if (/\/\d{4}-\d{2}/.test(pathname)) {
      return false;
    }
    
    // Exclude feed links, trackbacks, admin links
    if (pathname.includes('/feed/') || 
        pathname.includes('/comments/') || 
        pathname.includes('/wp-json/') || 
        pathname.includes('/wp-admin/') ||
        pathname.includes('xmlrpc.php')) {
      return false;
    }
    
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Normalizes page URLs by stripping search parameters and hash fragments.
 */
function normalizePageUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    parsed.hash = '';
    parsed.search = '';
    // Normalize trailing slash
    let href = parsed.href;
    return href;
  } catch (e) {
    return urlStr;
  }
}

/**
 * Helper to calculate relative path between two files in our workspace.
 */
function getRelativePath(fromFile, toFile) {
  const fromDir = path.posix.dirname(fromFile);
  let relative = path.posix.relative(fromDir, toFile);
  if (!relative.startsWith('.') && !relative.startsWith('/')) {
    relative = './' + relative;
  }
  return relative;
}

/**
 * Map a remote URL to a clean local file path in the workspace.
 */
function urlToLocalPath(urlStr, context) {
  try {
    const parsed = new URL(urlStr);
    const isInternal = parsed.hostname === DOMAIN || parsed.hostname === ALT_DOMAIN;
    let pathname = parsed.pathname;
    
    // If pathname is root or ends with slash, map to index.html
    if (pathname.endsWith('/') || pathname === '') {
      pathname = path.posix.join(pathname, 'index.html');
    }
    
    let ext = path.posix.extname(pathname);
    if (!ext) {
      if (isInternal && !context) {
        // WordPress page
        pathname = path.posix.join(pathname, 'index.html');
      } else if (context === 'css') {
        pathname += '.css';
      } else if (context === 'js') {
        pathname += '.js';
      } else if (context === 'image') {
        pathname += '.png';
      }
    }
    
    // Sanitize path segments to remove invalid Windows characters
    let segments = pathname.split('/').map(seg => {
      // Replace Windows-unfriendly chars: < > : " \ | ? *
      return seg.replace(/[<>:"|?*]/g, '_');
    });
    let sanitizedPathname = segments.join('/');
    
    let localPath;
    if (isInternal) {
      localPath = sanitizedPathname.startsWith('/') ? sanitizedPathname.slice(1) : sanitizedPathname;
    } else {
      const sanitizedHost = parsed.hostname.replace(/[<>:"|?*]/g, '_');
      localPath = path.posix.join('external', sanitizedHost, sanitizedPathname.startsWith('/') ? sanitizedPathname.slice(1) : sanitizedPathname);
    }
    
    return localPath;
  } catch (e) {
    // If URL is invalid, generate a safe name under a fallback folder
    console.error(`[Path Error] Invalid URL: ${urlStr}`);
    return `fallback/${Date.now()}.bin`;
  }
}

/**
 * Add an asset to the download queue and return its planned local path.
 */
function queueAsset(urlStr, context) {
  // Strip fragment
  const url = new URL(urlStr);
  url.hash = '';
  const cleanUrl = url.href;
  
  if (assetsQueue.has(cleanUrl)) {
    return assetsQueue.get(cleanUrl);
  }
  
  const localPath = urlToLocalPath(cleanUrl, context);
  assetsQueue.set(cleanUrl, localPath);
  
  // Schedule the download task asynchronously in the background
  downloadQueue.add(() => downloadAssetTask(cleanUrl, localPath));
  
  return localPath;
}

/**
 * The actual worker task that downloads the asset and writes it to disk.
 */
async function downloadAssetTask(urlStr, localPath) {
  if (downloadedAssets.has(urlStr) || failedDownloads.has(urlStr)) {
    return;
  }
  
  const absoluteDest = path.join(OUTPUT_DIR, localPath);
  
  // Ensure the directory exists
  fs.mkdirSync(path.dirname(absoluteDest), { recursive: true });
  
  try {
    console.log(`[Asset] Downloading: ${urlStr} -> ${localPath}`);
    const isCss = urlStr.includes('.css') || localPath.endsWith('.css');
    
    if (isCss) {
      // Stylesheets need internal URL rewriting
      const res = await fetchWithTimeout(urlStr);
      let cssText = await res.text();
      cssText = rewriteCssUrls(cssText, urlStr, localPath);
      fs.writeFileSync(absoluteDest, cssText, 'utf8');
    } else {
      // General binary file download
      const res = await fetchWithTimeout(urlStr);
      const buffer = await res.arrayBuffer();
      fs.writeFileSync(absoluteDest, Buffer.from(buffer));
    }
    downloadedAssets.add(urlStr);
  } catch (e) {
    console.error(`[Asset Error] Failed to download asset ${urlStr}: ${e.message}`);
    failedDownloads.add(urlStr);
  }
}

/**
 * Scan CSS code for url(...) declarations, download external resources and rewrite their paths.
 */
function rewriteCssUrls(cssContent, cssFileUrl, cssLocalPath) {
  const urlRegex = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g;
  
  return cssContent.replace(urlRegex, (match, urlVal) => {
    // Skip data URIs or empty/anchor values
    if (urlVal.startsWith('data:') || urlVal.startsWith('#') || urlVal.trim() === '') {
      return match;
    }
    
    const absUrl = resolveUrl(cssFileUrl, urlVal);
    
    // We treat files in CSS as images/fonts by default
    const context = (absUrl.includes('.woff') || absUrl.includes('.ttf') || absUrl.includes('.eot')) ? 'font' : 'image';
    const localPath = queueAsset(absUrl, context);
    const relativePath = getRelativePath(cssLocalPath, localPath);
    
    return `url('${relativePath}')`;
  });
}

/**
 * Rewrite srcset attributes for responsive images.
 */
function rewriteSrcset(srcsetStr, currentPageLocalPath, baseUrl) {
  if (!srcsetStr) return '';
  const parts = srcsetStr.split(',');
  const rewrittenParts = parts.map(part => {
    const trimmed = part.trim();
    if (!trimmed) return '';
    const subParts = trimmed.split(/\s+/);
    const urlVal = subParts[0];
    const descriptor = subParts.slice(1).join(' ');
    
    const absUrl = resolveUrl(baseUrl, urlVal);
    const localPath = queueAsset(absUrl, 'image');
    const relativePath = getRelativePath(currentPageLocalPath, localPath);
    
    return descriptor ? `${relativePath} ${descriptor}` : relativePath;
  });
  return rewrittenParts.filter(p => p).join(', ');
}

/**
 * Main scraper worker that processes HTML pages.
 */
async function processPage(pageUrl) {
  const localPath = urlToLocalPath(pageUrl);
  const absoluteDest = path.join(OUTPUT_DIR, localPath);
  
  console.log(`\n========================================`);
  console.log(`[Page] Processing: ${pageUrl} -> ${localPath}`);
  console.log(`========================================`);
  
  try {
    const res = await fetchWithTimeout(pageUrl);
    let htmlText = await res.text();
    
    // Apply user-requested content translations
    const nameRegex = /F(?:é|&eacute;)d(?:é|&eacute;)ration\s+des\s+Arts\s+Participatifs\s+et\s+des\s+Cr(?:é|&eacute;)ations\s+Partag(?:e|é|&eacute;)es/gi;
    const addressRegex = /7\s+Rue\s+Major\s+Martin\s+69001\s+Lyon/gi;
    const assocRegex = /Association\s+Loi\s+1901\s*\|\s*RNA\s*:\s*[\s\r\n]*W691111672\s*\|\s*Siret\s*:\s*992825414/gi;
    const emailRegex = /contact@federation-apcp\.org/gi;
    
    htmlText = htmlText.replace(nameRegex, 'LE MASQUE ET LA BRETTE');
    htmlText = htmlText.replace(addressRegex, '4 B rue du Vieux Marais, Couarde-sur-Mer, Nouvelle-Aquitaine');
    htmlText = htmlText.replace(assocRegex, 'Association Loi 1901 | RNA : W173010700');
    htmlText = htmlText.replace(emailRegex, 'contact@leslamesrethaises.fr');
    
    const $ = cheerio.load(htmlText);
    
    // 1. Process stylesheet links
    $('link[rel="stylesheet"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        const absUrl = resolveUrl(pageUrl, href);
        const assetLocalPath = queueAsset(absUrl, 'css');
        const relPath = getRelativePath(localPath, assetLocalPath);
        $(el).attr('href', relPath);
      }
    });
    
    // 2. Process scripts
    $('script[src]').each((i, el) => {
      const src = $(el).attr('src');
      if (src) {
        const absUrl = resolveUrl(pageUrl, src);
        const assetLocalPath = queueAsset(absUrl, 'js');
        const relPath = getRelativePath(localPath, assetLocalPath);
        $(el).attr('src', relPath);
      }
    });
    
    // 3. Process images
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      if (src) {
        const absUrl = resolveUrl(pageUrl, src);
        const assetLocalPath = queueAsset(absUrl, 'image');
        const relPath = getRelativePath(localPath, assetLocalPath);
        $(el).attr('src', relPath);
      }
      
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const rewrittenSrcset = rewriteSrcset(srcset, localPath, pageUrl);
        $(el).attr('srcset', rewrittenSrcset);
      }
    });
    
    // 4. Process source tags (responsive video/images)
    $('source').each((i, el) => {
      const src = $(el).attr('src');
      if (src) {
        const absUrl = resolveUrl(pageUrl, src);
        const assetLocalPath = queueAsset(absUrl);
        const relPath = getRelativePath(localPath, assetLocalPath);
        $(el).attr('src', relPath);
      }
      
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const rewrittenSrcset = rewriteSrcset(srcset, localPath, pageUrl);
        $(el).attr('srcset', rewrittenSrcset);
      }
    });
    
    // 5. Process inline styles with urls on elements
    $('[style*="url("]').each((i, el) => {
      const style = $(el).attr('style');
      if (style) {
        const rewrittenStyle = rewriteCssUrls(style, pageUrl, localPath);
        $(el).attr('style', rewrittenStyle);
      }
    });
    
    // 6. Process inline style blocks (<style> tags)
    $('style').each((i, el) => {
      const css = $(el).text();
      if (css) {
        const rewrittenCss = rewriteCssUrls(css, pageUrl, localPath);
        $(el).text(rewrittenCss);
      }
    });
    
    // 7. Process site icons / favicons
    $('link[rel*="icon"], link[rel="apple-touch-icon"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        const absUrl = resolveUrl(pageUrl, href);
        const assetLocalPath = queueAsset(absUrl, 'image');
        const relPath = getRelativePath(localPath, assetLocalPath);
        $(el).attr('href', relPath);
      }
    });
    
    // 8. Process page links <a>
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href').trim();
      
      // Skip mailto, tel, javascript, anchors, or empty values
      if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:') || href.startsWith('#') || !href) {
        return;
      }
      
      const absUrl = resolveUrl(pageUrl, href);
      
      if (isInternalUrl(absUrl)) {
        const parsedTarget = new URL(absUrl);
        const targetExt = path.extname(parsedTarget.pathname).toLowerCase();
        
        // Check if it's an asset extension rather than an HTML page
        const assetExtensions = ['.pdf', '.zip', '.docx', '.xlsx', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.mp4', '.mp3', '.epub', '.txt', '.xml', '.json'];
        if (assetExtensions.includes(targetExt)) {
          const assetLocalPath = queueAsset(absUrl);
          const relPath = getRelativePath(localPath, assetLocalPath);
          $(el).attr('href', relPath);
        } else {
          const cleanPageUrl = normalizePageUrl(absUrl);
          
          if (shouldCrawlPage(cleanPageUrl)) {
            const targetLocalPath = urlToLocalPath(cleanPageUrl);
            const relPath = getRelativePath(localPath, targetLocalPath);
            $(el).attr('href', relPath);
            
            // Add internal page to queue if not already visited
            if (!visitedPages.has(cleanPageUrl)) {
              visitedPages.add(cleanPageUrl);
              pagesQueue.push(cleanPageUrl);
              console.log(`[Link] Queued page: ${cleanPageUrl}`);
            }
          } else {
            // Keep dynamic/infinite pages as remote URLs to avoid crawler traps
            $(el).attr('href', absUrl);
          }
        }
      }
    });
    
    // Write rewritten HTML page to disk
    fs.mkdirSync(path.dirname(absoluteDest), { recursive: true });
    fs.writeFileSync(absoluteDest, $.html(), 'utf8');
    console.log(`[Page] Saved: ${localPath}`);
    
  } catch (e) {
    console.error(`[Page Error] Failed to process page ${pageUrl}: ${e.message}`);
  }
}

/**
 * Main application coordinator.
 */
async function main() {
  console.log('Starting website downloader...');
  console.log(`Seed URL: ${BASE_URL}`);
  console.log(`Output Directory: ${OUTPUT_DIR}\n`);
  
  // Crawler loop for HTML pages
  while (pagesQueue.length > 0) {
    const pageUrl = pagesQueue.shift();
    await processPage(pageUrl);
    // Pause briefly to respect the server
    await delay(300);
  }
  
  console.log('\n--- Pages crawling complete! Waiting for final asset downloads... ---');
  
  // Keep checking until downloadQueue is empty and no running tasks
  while (downloadQueue.queue.length > 0 || downloadQueue.running > 0) {
    console.log(`Progress: ${downloadedAssets.size} assets completed, ${assetsQueue.size - downloadedAssets.size - failedDownloads.size} pending, ${failedDownloads.size} failed...`);
    await delay(2000);
  }
  
  console.log('\n========================================');
  console.log('           DOWNLOAD COMPLETE!           ');
  console.log(`Total Pages Crawled: ${visitedPages.size}`);
  console.log(`Total Assets Downloaded: ${downloadedAssets.size}`);
  if (failedDownloads.size > 0) {
    console.log(`Failed Downloads: ${failedDownloads.size} (see console warnings above)`);
  }
  console.log(`All files saved locally to: ${OUTPUT_DIR}`);
  console.log('========================================');
}

main().catch(err => {
  console.error('Fatal error in downloader:', err);
});
