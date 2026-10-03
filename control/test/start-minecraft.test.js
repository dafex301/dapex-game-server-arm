import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const launcher = new URL('../../scripts/start-minecraft.sh', import.meta.url);

test('runs Minecraft with the host operator UID and GID', async () => {
  const script = await readFile(launcher, 'utf8');

  assert.match(script, /host_uid=\$\(id -u\)/);
  assert.match(script, /host_gid=\$\(id -g\)/);
  assert.match(script, /--env UID="\$host_uid" --env GID="\$host_gid"/);
});
