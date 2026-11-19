'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('./upload_to_odcs');
const { buildMetadataPlans, updateMetadata } = require('./update_metadata');
const { datasetMarker, tableMarker, readImageMetadata, csvMetadata } = require('./metadata');
const { prepareImageUploads } = require('./odcs_images');

const config = { ...loadConfig({}), apiKey: 'test-only-key' };
const owner = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets.json'), 'utf8')).owner_org;
const sink = { write() {} };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odcs-metadata-'));
  const plans = buildMetadataPlans(config);
  const state = { calls: [], datasets: plans.map((plan) => ({
    id: plan.dataset.id, owner_org: owner, title: '旧名称', notes: datasetMarker(plan.target), url: '', tags: [{ name: 'repot' }],
    extras: [{ key: 'custom', value: '保持する値' }, { key: 'frequency', value: '随時' }],
    resources: [{ id: plan.table.id, package_id: plan.dataset.id, name: `${plan.target}.json`, description: tableMarker(plan.target),
      url_type: 'datastore', url: 'datastore', format: 'JSON' },
    ...plan.images.map((image, index) => ({ id: `${plan.target}-image-${index}`, package_id: plan.dataset.id,
      name: image.legacy_name, description: `repot-image-v1:${JSON.stringify({ filename: image.filename, sha256: image.sha256 })}`,
      url: `https://data.bodik.jp/fixture/${plan.target}/${image.filename}`, url_type: 'upload', format: 'PNG' }))],
  })) };
  const rows = new Map(plans.map((plan) => [plan.table.id, plan.images.map((image, index) => ({
    _id: index + 1, slug: image.filename, image_url: `https://data.bodik.jp/fixture/${plan.target}/${image.filename}`,
  }))]));
  state.request = async (action, params, method = 'GET') => {
    state.calls.push({ action, params, method });
    if (action === 'package_show') return state.datasets.find((dataset) => dataset.id === params.id);
    if (action === 'resource_show') return state.datasets.flatMap((dataset) => dataset.resources).find((resource) => resource.id === params.id);
    if (action === 'datastore_search') {
      const records = structuredClone(rows.get(params.resource_id));
      return { records, total: records.length };
    }
    if (action === 'package_patch') {
      assert.ok(Object.keys(params).every((key) => ['id', 'title', 'notes', 'url', 'tags', 'extras'].includes(key)));
      const dataset = state.datasets.find((dataset) => dataset.id === params.id);
      return Object.assign(dataset, params);
    }
    if (action === 'resource_patch') {
      assert.deepEqual(Object.keys(params).sort(), ['description', 'id', 'name']);
      const resource = state.datasets.flatMap((dataset) => dataset.resources).find((resource) => resource.id === params.id);
      return Object.assign(resource, params);
    }
    assert.fail(`メタデータ以外のAPIは禁止: ${action}`);
  };
  state.fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const params = options.method === 'POST' ? JSON.parse(options.body) : Object.fromEntries(url.searchParams);
    const result = await state.request(url.pathname.split('/').pop(), params, options.method);
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  return { plans, state, options: { send: true, config, stdout: sink, fetchImpl: state.fetchImpl,
    backupPath: path.join(dir, 'backup.json'), reportPath: path.join(dir, 'report.json') },
  close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('説明文の通常実行は無通信で、公開文には内部の管理文字列を表示しない', async () => {
  let output = '';
  await updateMetadata({ config, stdout: { write: (value) => { output += value; } }, fetchImpl: async () => assert.fail('通信禁止') });
  for (const plan of JSON.parse(output).datasets) {
    const visible = plan.dataset.notes.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(visible.startsWith('【試行中】'));
    assert.ok(visible.includes('出典：') && visible.includes('加工内容：'));
    assert.equal(visible.includes('repot-managed'), false);
    assert.equal(visible.includes('.js'), false);
  }
});

test('説明と表示名だけを更新し、元データとURLを保ち、再実行・画像再利用ができる', async () => {
  const f = fixture();
  const plan = f.plans[0];
  const csv = csvMetadata(plan.target, plan.csv, { table_resource_id: plan.table.id, sha256: 'a'.repeat(64) });
  f.state.datasets[0].resources.push({ id: 'existing-csv', package_id: plan.dataset.id, url_type: 'upload', format: 'CSV',
    url: 'https://data.bodik.jp/fixture/records.csv', ...csv, description: csv.description.replace(/\r?\n/g, '\r\n') });
  try {
    const report = await updateMetadata(f.options);
    assert.equal(report.completed.length, f.plans.reduce((count, plan) => count + 2 + plan.images.length, 0));
    assert.ok(report.completed.every((entry) => entry.id !== 'existing-csv'));
    assert.ok(report.verified.every((entry) => entry.dataUnchanged));
    assert.ok(fs.existsSync(f.options.backupPath));
    const posts = f.state.calls.filter((call) => call.method === 'POST').length;
    for (const [index, dataset] of f.state.datasets.entries()) {
      assert.equal(dataset.extras.find((entry) => entry.key === 'custom').value, '保持する値');
      assert.equal(dataset.extras.find((entry) => entry.key === 'frequency').value, '随時');
      assert.equal(dataset.extras.find((entry) => entry.key === 'language').value, 'Japanese');
      const plan = f.plans[index];
      const tasks = await prepareImageUploads(plan.images, { resource_id: plan.table.id }, config, f.state.request);
      assert.ok(tasks.every((task) => task.action === 'reuse'));
      assert.equal(readImageMetadata(dataset.resources[1].description).filename, plan.images[0].filename);
    }
    const second = await updateMetadata(f.options);
    assert.equal(second.completed.length, 0);
    assert.equal(f.state.calls.filter((call) => call.method === 'POST').length, posts);
  } finally { f.close(); }
});

test('後半の分類で画像情報が不一致なら、両分類とも更新前に停止する', async () => {
  const f = fixture();
  f.state.datasets[1].resources[1].description = '管理対象外の画像';
  try {
    await assert.rejects(updateMetadata(f.options), /管理情報/);
    assert.ok(f.state.calls.every((call) => call.method === 'GET'));
  } finally { f.close(); }
});

test('バックアップを作成できない場合は、公開メタデータの更新前に停止する', async () => {
  const f = fixture();
  fs.writeFileSync(f.options.backupPath, 'existing');
  try {
    await assert.rejects(updateMetadata(f.options), /EEXIST/);
    assert.ok(f.state.calls.every((call) => call.method === 'GET'));
  } finally { f.close(); }
});
