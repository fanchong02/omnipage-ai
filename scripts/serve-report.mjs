import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const { ensureReportServer, openReportInChrome, waitForReportServerExit } = await import(
  '../src/reporters/report-server.ts'
);

const reportPath = process.argv[2] ?? 'reports/regression-1782210567080/index.html';
const portHint = Number(process.argv[3] ?? 9321);

const port = await ensureReportServer(portHint);
const relative = reportPath.replace(/^reports\//, '');
const url = `http://127.0.0.1:${port}/${relative.replace(/\\/g, '/')}`;

console.log(`Report server: http://127.0.0.1:${port}`);
console.log(`Opening: ${url}`);

await openReportInChrome(join(root, reportPath));
console.log('Press Ctrl+C to stop the server.');

await waitForReportServerExit();
