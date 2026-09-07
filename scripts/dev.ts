import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const children: ChildProcess[] = [];

function start(name: string, cmd: string, args: string[], color: string) {
  const child = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${color}m${name.padEnd(6)}\x1b[0m`;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) console.log(`${tag} ${line}`);
    });
  }
  child.on('exit', (code) => {
    console.log(`${tag} exited with ${code}`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

let shuttingDown = false;
function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('api', process.execPath, [resolve(root, 'server/main.ts')], '36');
start('web', 'npx', ['vite'], '35');

console.log('\ndashboard: http://localhost:5273\n');
