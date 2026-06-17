const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf'
};

const server = http.createServer((req, res) => {
  console.log(`[Request] ${req.method} ${req.url}`);
  
  // Normalize URL path and strip query parameters
  let decodedUrl;
  try {
    decodedUrl = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    decodedUrl = req.url.split('?')[0];
  }
  
  let reqPath = decodedUrl;
  if (reqPath.endsWith('/')) {
    reqPath += 'index.html';
  }
  
  // Resolve local file path
  let filePath = path.join(__dirname, reqPath);
  
  // If file doesn't exist, check folder index.html
  if (!fs.existsSync(filePath)) {
    const indexPath = path.join(filePath, 'index.html');
    if (fs.existsSync(indexPath)) {
      filePath = indexPath;
    } else {
      // Return 404
      console.warn(`[404] File not found: ${filePath}`);
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('404 Not Found');
      return;
    }
  }
  
  // Read and serve file
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    res.statusCode = 500;
    res.end('Server Error');
  });
  stream.pipe(res);
});

server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  Local server is running successfully!  `);
  console.log(`  Open: http://localhost:${PORT}/        `);
  console.log(`========================================\n`);
});
