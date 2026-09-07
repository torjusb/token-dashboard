import { openSync, closeSync, readSync, statSync } from 'node:fs';

export type TailPosition = { offset: number; size: number; mtimeMs: number };

export function tailFile(filePath: string, prev: TailPosition | null): { lines: string[] } & TailPosition {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return prev === null ? { lines: [], offset: 0, size: 0, mtimeMs: 0 } : { lines: [], ...prev };
  }

  const size = stat.size;
  const mtimeMs = stat.mtimeMs;

  if (prev === null) {
    return readFrom(filePath, 0, size, mtimeMs);
  }

  if (size < prev.size) {
    return readFrom(filePath, 0, size, mtimeMs);
  }

  if (size === prev.size && mtimeMs === prev.mtimeMs) {
    return { lines: [], offset: prev.offset, size: prev.size, mtimeMs: prev.mtimeMs };
  }

  return readFrom(filePath, prev.offset, size, mtimeMs);
}

function readFrom(filePath: string, from: number, size: number, mtimeMs: number): { lines: string[] } & TailPosition {
  const length = size - from;
  if (length <= 0) {
    return { lines: [], offset: from, size, mtimeMs };
  }

  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return { lines: [], offset: from, size, mtimeMs };
  }

  try {
    const buf = Buffer.alloc(length);
    let readTotal = 0;
    while (readTotal < length) {
      const n = readSync(fd, buf, readTotal, length - readTotal, from + readTotal);
      if (n === 0) break;
      readTotal += n;
    }

    const chunk = buf.subarray(0, readTotal);
    const lastNewline = chunk.lastIndexOf(0x0a);
    const complete = lastNewline === -1 ? chunk.subarray(0, 0) : chunk.subarray(0, lastNewline + 1);
    const consumed = lastNewline === -1 ? 0 : lastNewline + 1;

    const text = complete.toString('utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);

    return { lines, offset: from + consumed, size, mtimeMs };
  } finally {
    closeSync(fd);
  }
}
