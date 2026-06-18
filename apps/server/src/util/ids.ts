import { createHash, randomUUID } from 'node:crypto';

export function stableId(...parts: Array<string | number | undefined>): string {
  return createHash('sha1')
    .update(parts.filter((part) => part !== undefined && part !== '').join(':'))
    .digest('hex')
    .slice(0, 16);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
