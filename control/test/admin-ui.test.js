import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const publicFile = (name) => new URL(`../public/${name}`, import.meta.url);

test('keeps the world reset form reference across its asynchronous request', async () => {
  const script = await readFile(publicFile('admin.js'), 'utf8');

  assert.match(script, /const form = event\.currentTarget;[\s\S]*state\.management = await api\('\/api\/admin\/world\/reset'[\s\S]*form\.reset\(\)/);
});

test('validates safe world names and renders a bounded nested file tree', async () => {
  const [html, script, style] = await Promise.all([
    readFile(publicFile('admin.html'), 'utf8'),
    readFile(publicFile('admin.js'), 'utf8'),
    readFile(publicFile('style.css'), 'utf8'),
  ]);

  assert.match(html, /name="name"[^>]+pattern="\[A-Za-z0-9]\[A-Za-z0-9\._-]\{0,63\}"/);
  assert.match(html, /id="file-tree"/);
  assert.match(script, /function renderTreeChildren\(/);
  assert.match(script, /data-tree-path=/);
  assert.match(style, /\.file-desktop\{[^}]*height:520px/);
  assert.match(style, /scrollbar-color:/);
});

test('offers keyboard command completion with player-aware suggestions', async () => {
  const [html, script, style] = await Promise.all([
    readFile(publicFile('admin.html'), 'utf8'),
    readFile(publicFile('admin.js'), 'utf8'),
    readFile(publicFile('style.css'), 'utf8'),
  ]);

  assert.match(html, /id="command-suggestions"/);
  assert.match(script, /const commandCatalog = \[/);
  assert.match(script, /const attributeIds = \[/);
  assert.match(script, /attribute <player> minecraft:<attribute> base set <value>/);
  assert.match(script, /template\.replace\('<player>', player\)/);
  assert.match(script, /item\.value\.replace\('minecraft:<attribute>', attribute\)/);
  assert.match(script, /raw\.startsWith\('\/'\) \? raw : `tellraw @a \$\{JSON\.stringify/);
  assert.match(script, /\[Tuhan] \$\{raw\}/);
  assert.match(script, /raw\.startsWith\('\/'\)/);
  assert.match(script, /event\.key === 'Tab' \|\| event\.key === 'Enter'/);
  assert.match(script, /navigateCommandHistory\(event\.key === 'ArrowUp' \? 1 : -1\)/);
  assert.match(style, /\.command-suggestions button\.active/);
  assert.match(style, /\.command-suggestions code,[^}]+display:block!important/);
});
