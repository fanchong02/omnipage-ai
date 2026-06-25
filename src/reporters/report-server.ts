import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { getRootDir } from '../config.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

let server: Server | null = null;
let serverPort: number | null = null;
let reportsRoot = join(getRootDir(), 'reports');

const findAvailablePort = async (startPort: number) => {
  for (let port = startPort; port < startPort + 20; port += 1) {
    const available = await new Promise<boolean>(resolve => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve(true));
      });
    });
    if (available) return port;
  }
  throw new Error(`No available port found near ${startPort}`);
};

export const ensureReportServer = async (portHint = 9321): Promise<number> => {
  if (server && serverPort) return serverPort;

  reportsRoot = join(getRootDir(), 'reports');
  const port = await findAvailablePort(portHint);

  server = createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
      const filePath = join(reportsRoot, safePath === '/' ? 'index.html' : safePath);

      if (!filePath.startsWith(reportsRoot) || !existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        const indexPath = join(filePath, 'index.html');
        if (!existsSync(indexPath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Directory listing not available');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        createReadStream(indexPath).pipe(res);
        return;
      }

      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(port, '127.0.0.1', () => resolve());
  });

  serverPort = port;
  return port;
};

export const getReportServerBaseUrl = () => {
  if (!serverPort) return undefined;
  return `http://127.0.0.1:${serverPort}`;
};

export const toReportUrl = async (reportHtmlPath: string) => {
  const port = await ensureReportServer();
  const root = join(getRootDir(), 'reports');
  const absolute = reportHtmlPath.startsWith('/')
    ? reportHtmlPath
    : join(getRootDir(), reportHtmlPath);
  const relative = absolute.startsWith(root)
    ? absolute.slice(root.length)
    : absolute.replace(getRootDir(), '');
  const normalized = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  return `http://127.0.0.1:${port}/${normalized}`;
};

const openUrlInChrome = (url: string) =>
  new Promise<void>((resolve, reject) => {
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === 'darwin') {
      command = 'open';
      args = ['-a', 'Google Chrome', url];
    } else if (platform === 'win32') {
      command = 'cmd';
      args = ['/c', 'start', 'chrome', url];
    } else {
      command = 'google-chrome';
      args = [url];
    }

    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      spawn('open', [url], { stdio: 'ignore', detached: true })
        .on('error', reject)
        .on('spawn', () => resolve());
    });
    child.on('spawn', () => resolve());
  });

export const openReportInChrome = async (reportHtmlPath: string) => {
  const url = await toReportUrl(reportHtmlPath);
  await openUrlInChrome(url);
  return url;
};

export const waitForReportServerExit = () =>
  new Promise<void>(resolve => {
    const done = () => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });

export const closeReportServer = async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server!.close(err => (err ? reject(err) : resolve()));
  });
  server = null;
  serverPort = null;
};
