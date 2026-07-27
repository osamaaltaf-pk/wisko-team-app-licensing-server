const http = require('http');
const fs = require('fs');
const path = require('path');

const activate = require('./api/activate');
const verify = require('./api/verify');
const trackGeneration = require('./api/track-generation');
const generateKey = require('./api/generate-key');
const analytics = require('./api/analytics');

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Vercel response helper mock
  const vercelRes = {
    status(code) {
      res.statusCode = code;
      return this;
    },
    json(data) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
      return this;
    },
    end() {
      res.end();
      return this;
    },
    setHeader(name, value) {
      res.setHeader(name, value);
      return this;
    }
  };
  
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(body);
      } catch (e) {}
      
      const vercelReq = {
        method: req.method,
        body: parsedBody
      };
      
      if (req.url === '/api/activate') {
        activate(vercelReq, vercelRes);
      } else if (req.url === '/api/verify') {
        verify(vercelReq, vercelRes);
      } else if (req.url === '/api/track-generation') {
        trackGeneration(vercelReq, vercelRes);
      } else if (req.url === '/api/generate-key') {
        generateKey(vercelReq, vercelRes);
      } else if (req.url === '/api/analytics') {
        analytics(vercelReq, vercelRes);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: "Route not found" }));
      }
    });
  } else if (req.method === 'GET') {
    // Serve dashboard files
    const parsedUrl = req.url.split('?')[0];
    let file = parsedUrl === '/' ? '/index.html' : parsedUrl;
    let filePath = path.join(__dirname, 'public', file);
    
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: "Dashboard file not found." }));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      }
    });
  } else {
    res.writeHead(405);
    res.end();
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Local development license server running on http://localhost:${PORT}`);
});
