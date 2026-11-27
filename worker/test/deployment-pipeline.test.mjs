import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

test('hosted Worker release workflow migrates isolated PostgreSQL/PostGIS before deploy', async () => {
  const workflow = await readFile(new URL('.github/workflows/deploy-tourism-worker.yml', root), 'utf8');
  const taxonomyTest = await readFile(new URL('supabase/tests/tourism_taxonomy.sql', root), 'utf8');
  const fixtures = await readFile(new URL('supabase/tests/heritage_content_fixtures.sql', root), 'utf8');
  assert.match(workflow, /postgis\/postgis:17-3\.7/);
  assert.match(workflow, /targets the Worker in Wrangler configuration/);
  assert.match(workflow, /Check the current public API before uploading a new version/);
  assert.match(workflow, /https:\/\/india-tourism-collector\.promoacc123123\.workers\.dev/);
  assert.ok(workflow.indexOf('pnpm test') < workflow.indexOf('Check the current public API before uploading a new version'));
  assert.ok(workflow.indexOf('pnpm typecheck') < workflow.indexOf('Check the current public API before uploading a new version'));
  assert.ok(workflow.indexOf('Check the current public API before uploading a new version') < workflow.indexOf('Deploy to the existing tourism pilot Worker'));
  assert.match(workflow, /supabase\/migrations/);
  assert.match(workflow, /supabase\/tests\/tourism_taxonomy\.sql/);
  assert.match(workflow, /needs:\s*verify/);
  assert.match(workflow, /dev\/session-b-multicity/);
  assert.match(workflow, /dev\/session-c-enrichment/);
  assert.match(taxonomyTest, /localise_taxonomy/);
  assert.match(taxonomyTest, /has_function_privilege\('anon'/);
  assert.match(taxonomyTest, /nearby_escapes|scenic_spots/);
  assert.ok(workflow.indexOf('20261128_offline_pbf_publication.sql') < workflow.indexOf('20261126143000_offline_pbf_attribution_encoding_repair.sql'));
  assert.ok(workflow.indexOf('20261126143000_offline_pbf_attribution_encoding_repair.sql') < workflow.indexOf('20261126150000_offline_pbf_wikidata_reconciliation.sql'));
  assert.ok(workflow.indexOf('20261129_tourism_taxonomy.sql') > workflow.indexOf('20261126180000_heritage_fee_encoding.sql'));
  assert.match(fixtures, /Synthetic migration fixtures for an isolated CI database only/);
  assert.match(workflow, /if \[\[ "\$migration" == 'supabase\/migrations\/20261126164621_heritage_card_content_20261126\.sql' \]\]; then[\s\S]*?psql -v ON_ERROR_STOP=1 -f supabase\/tests\/heritage_content_fixtures\.sql/);
});
