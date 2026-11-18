#!/usr/bin/env node
// Install the tracked model metadata without replacing personal providers or credentials.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const source = JSON.parse(readFileSync(new URL('../.pi/models.json', import.meta.url), 'utf8'));
const agentDir = resolve(process.argv[2] ?? join(homedir(), '.pi', 'agent'));
const target = join(agentDir, 'models.json');
const current = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
if (!object(current) || (current.providers !== undefined && !object(current.providers)))
  throw new Error('Expected models.json and its providers to be objects; no changes written.');
current.providers ??= {};
for (const [name, settings] of Object.entries(source.providers)) {
  const provider = current.providers[name] ??= {};
  if (!object(provider) || (provider.modelOverrides !== undefined && !object(provider.modelOverrides)))
    throw new Error(`Expected ${name} and its modelOverrides to be objects; no changes written.`);
  provider.modelOverrides ??= {};
  for (const [id, metadata] of Object.entries(settings.modelOverrides)) {
    const previous = provider.modelOverrides[id] ?? {};
    if (!object(previous)) throw new Error(`Expected ${id} override to be an object; no changes written.`);
    provider.modelOverrides[id] = { ...previous, ...metadata };
  }
}
mkdirSync(agentDir, { recursive: true });
const temporary = `${target}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, target);
console.log(`Installed model settings in ${target}`);
