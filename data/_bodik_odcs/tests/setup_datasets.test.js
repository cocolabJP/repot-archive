'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { provision, FIELDS, datasetMarker } = require('../setup_datasets');
const { loadConfig } = require('../upload_to_odcs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odcs-datasets-'));
  const filename = path.join(dir, 'datasets.json');
  const registry = { source_dataset_id: 'source-dataset', owner_org: 'test-org', license_id: 'cc-by-40-intl', targets: {
    komaruKurage: { name: 'repot-komaru-kurage', title: 'クラゲ', dataset_id: '', resource_id: '' },
    chushikokuSakana: { name: 'repot-chushikoku-sakana', title: '魚', dataset_id: '', resource_id: '' },
  } };
  fs.writeFileSync(filename, JSON.stringify(registry));
  const state = { calls: [], datasets: [{ id: 'source-dataset', owner_org: 'test-org', license_id: registry.license_id, resources: [] }] };
  state.fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const action = url.pathname.split('/').pop();
    const params = options.method === 'POST' ? JSON.parse(options.body) : Object.fromEntries(url.searchParams);
    state.calls.push({ action, method: options.method, params });
    let result;
    if (action === 'package_show') {
      result = state.datasets.find((dataset) => dataset.id === params.id || dataset.name === params.id);
      if (!result) return { ok: false, status: 404, json: async () => ({ success: false, error: { message: 'not found' } }) };
    } else if (action === 'package_create') {
      assert.ok(params.tags.every((tag) => tag.name.length >= 2));
      result = { ...params, id: `dataset-${state.datasets.length}`, resources: [], state: 'active' };
      state.datasets.push(result);
    } else if (action === 'datastore_create') {
      assert.equal(params.force, undefined);
      assert.deepEqual(params.primary_key, ['id']);
      assert.equal(params.fields.length, 17);
      const dataset = state.datasets.find((dataset) => dataset.id === params.resource.package_id);
      assert.notEqual(dataset.id, 'source-dataset');
      const resource = { ...params.resource, id: `table-${dataset.id}` };
      dataset.resources.push(resource);
      result = { resource_id: resource.id };
    } else if (action === 'resource_show') {
      result = state.datasets.flatMap((dataset) => dataset.resources).find((resource) => resource.id === params.id);
    } else if (action === 'datastore_info') {
      result = { fields: FIELDS.map((field) => ({ ...field, schema: { uniquekey: field.id === 'id' } })) };
    } else assert.fail(action);
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  return { filename, registry, state, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const config = { ...loadConfig({}), apiKey: 'test-only-key' };
const sink = { write() {} };

test('データセット作成の通常実行は外部通信・設定変更をしない', async () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.filename, 'utf8');
    await provision({ registryPath: f.filename, config, stdout: sink, fetchImpl: async () => assert.fail('通信禁止') });
    assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
  } finally { f.close(); }
});

test('独立した2データセットに新しい投稿表を作り、再実行は管理対象だけ再利用する', async () => {
  const f = fixture();
  try {
    const options = { send: true, registryPath: f.filename, config, stdout: sink, fetchImpl: f.state.fetchImpl };
    const result = await provision(options);
    const ids = Object.values(result.targets).map((target) => target.dataset_id);
    assert.equal(new Set(ids).size, 2);
    assert.ok(Object.values(result.targets).every((target) => target.resource_id));
    assert.equal(f.state.calls.filter((call) => call.method === 'POST').length, 4);
    await provision(options);
    assert.equal(f.state.calls.filter((call) => call.method === 'POST').length, 4);
    assert.deepEqual(f.state.datasets[0].resources, []);
  } finally { f.close(); }
});

test('同名の別組織データセットは変更せず、どちらも作成前に停止する', async () => {
  const f = fixture();
  f.state.datasets.push({ id: 'foreign', name: f.registry.targets.chushikokuSakana.name, owner_org: 'another-org',
    notes: datasetMarker('chushikokuSakana'), resources: [] });
  try {
    await assert.rejects(provision({ send: true, registryPath: f.filename, config, stdout: sink, fetchImpl: f.state.fetchImpl }), /管理対象/);
    assert.ok(f.state.calls.every((call) => call.method === 'GET'));
  } finally { f.close(); }
});
