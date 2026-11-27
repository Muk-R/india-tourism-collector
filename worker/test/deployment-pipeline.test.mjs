import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

test('hosted Worker release workflow migrates isolated PostgreSQL/PostGIS before deploy', async () => {
  const workflow = await readFile(new URL('.github/workflows/deploy-tourism-worker.yml', root), 'utf8');
  const taxonomyTest = await readFile(new URL('supabase/tests/tourism_taxonomy.sql', root), 'utf8');
  assert.match(workflow, /postgis\/postgis:17-3\.7/);
  assert.match(workflow, /supabase\/migrations/);
  assert.match(workflow, /supabase\/tests\/tourism_taxonomy\.sql/);
  assert.match(workflow, /needs:\s*verify/);
  assert.match(workflow, /dev\/session-b-multicity/);
  assert.match(workflow, /dev\/session-c-enrichment/);
  assert.match(taxonomyTest, /localise_taxonomy/);
  assert.match(taxonomyTest, /has_function_privilege\('anon'/);
  assert.match(taxonomyTest, /nearby_escapes|scenic_spots/);
});
