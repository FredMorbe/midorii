import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateRuleStrategy } from '../../shared/strategies/rules.js';

const writes = new Map();

export async function loadRules(dir) {
  let text;
  try { text = await readFile(path.join(dir, 'research-strategies.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rules = JSON.parse(text);
  if (!Array.isArray(rules) || rules.length > 200) throw new Error('Invalid custom strategy library');
  const validated = rules.map(validateRuleStrategy);
  if (new Set(validated.map((rule) => rule.id)).size !== validated.length) throw new Error('Duplicate custom strategy ids');
  return validated;
}

export async function saveRule(dir, input, replace = false) {
  const rule = validateRuleStrategy(input);
  const previous = writes.get(dir) ?? Promise.resolve();
  const writing = previous.catch(() => undefined).then(async () => {
    const all = await loadRules(dir);
    const index = all.findIndex((entry) => entry.id === rule.id);
    if (replace && index < 0) throw new Error('No custom strategy with this id');
    if (!replace && index >= 0) throw new Error('This strategy already exists; use update to replace it');
    if (index < 0 && all.length >= 200) throw new Error('The custom strategy library is full');
    if (index < 0) all.push(rule); else all[index] = rule;
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'research-strategies.json');
    await writeFile(`${file}.tmp`, JSON.stringify(all, null, 2), 'utf8');
    await rename(`${file}.tmp`, file);
    return rule;
  });
  writes.set(dir, writing);
  try { return await writing; }
  finally { if (writes.get(dir) === writing) writes.delete(dir); }
}
