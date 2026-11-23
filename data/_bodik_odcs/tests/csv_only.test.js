'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadConfig, buildUploadPlans, run } = require('../upload_to_odcs');
const { generateCsvPlans, prepareCsvOnly, backupCsvOnly, publishCsvOnly, digest } = require('../lib/csv_only');
const { datasetMetadata, tableMarker, csvMetadata } = require('../lib/metadata');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odcs-csv-only-'));
  const config = { ...loadConfig({}), apiKey: 'test-only-key' };
  const plans = generateCsvPlans(buildUploadPlans(['komaruKurage', 'chushikokuSakana'], config), dir);
  const state = { calls: [], files: new Map(), failCsv: false, badDownload: false };
  state.datasets = plans.map((plan) => {
    const definition = config.definitions[plan.target];
    const record = plan.payload.records[0];
    const filename = new URL(record.image_url).pathname.split('/').pop();
    const photo = Buffer.from(`photo-${plan.target}`);
    const oldCsv = Buffer.from('old,17,columns\r\n');
    const csv = { id: definition.csv_resource_id, package_id: plan.dataset_id, url_type: 'upload', format: 'CSV',
      url: `https://data.bodik.jp/files/${plan.target}.csv`,
      ...csvMetadata(plan.target, definition, { table_resource_id: plan.payload.resource_id, sha256: digest(oldCsv) }) };
    const image = { id: `image-${plan.target}`, package_id: plan.dataset_id, name: `投稿写真_${filename}`,
      url_type: 'upload', format: 'PNG', url: `https://data.bodik.jp/files/${filename}`,
      description: `repot-image-v1:${JSON.stringify({ filename, sha256: digest(photo) })}` };
    const table = { id: plan.payload.resource_id, package_id: plan.dataset_id, name: '旧JSON表',
      url_type: 'datastore', format: 'JSON', description: tableMarker(plan.target), url: 'datastore' };
    state.files.set(csv.url, oldCsv); state.files.set(image.url, photo);
    return { id: plan.dataset_id, name: definition.name, owner_org: config.ownerOrg, ...datasetMetadata(plan.target, definition), resources: [table, image, csv] };
  });
  state.request = async (action, params, method = 'GET') => {
    state.calls.push({ action, params, method });
    let result;
    if (action === 'package_show') result = state.datasets.find((dataset) => dataset.id === params.id);
    else if (action === 'resource_show') result = state.datasets.flatMap((dataset) => dataset.resources).find((resource) => resource.id === params.id);
    else if (action === 'datastore_search') {
      assert.equal(method, 'GET');
      const plan = plans.find((plan) => plan.payload.resource_id === params.resource_id);
      result = { total: 1, records: [{ ...plan.payload.records[0], caption: state.changedJson ? '別処理による変更' : '' }] };
    } else if (action === 'resource_patch' || action === 'resource_create') {
      assert.equal(method, 'POST');
      const isFile = params instanceof FormData;
      if (state.failCsv && isFile && params.get('id') === config.definitions[plans[1].target].csv_resource_id) throw new Error('second CSV failed');
      const id = isFile ? params.get('id') : params.id;
      result = state.datasets.flatMap((dataset) => dataset.resources).find((resource) => resource.id === id);
      if (!result) {
        const packageId = params.get('package_id');
        result = { id: `new-${packageId}`, package_id: packageId, format: 'CSV', url_type: 'upload', url: `https://data.bodik.jp/files/${packageId}.csv` };
        state.datasets.find((dataset) => dataset.id === packageId).resources.push(result);
      }
      for (const key of ['name', 'description']) result[key] = isFile ? params.get(key) : params[key];
      if (isFile) {
        assert.equal(params.get('format'), 'CSV');
        const file = params.get('upload');
        assert.equal(file.type, 'text/csv');
        assert.match(file.name, /\.csv$/);
        state.files.set(result.url, Buffer.from(await file.arrayBuffer()));
      }
    } else if (action === 'package_patch') {
      result = Object.assign(state.datasets.find((dataset) => dataset.id === params.id), params);
    } else if (action === 'resource_delete') {
      assert.equal(method, 'POST');
      for (const dataset of state.datasets) dataset.resources = dataset.resources.filter((resource) => resource.id !== params.id);
      result = null;
    } else assert.fail(`画像・JSONの送信は禁止: ${action}`);
    return structuredClone(result);
  };
  state.fetchImpl = async (url, options) => {
    if (url.includes('/api/3/action/')) {
      const parsed = new URL(url);
      const params = options.method === 'GET' ? Object.fromEntries([...parsed.searchParams].map(([key, value]) => {
        try { return [key, JSON.parse(value)]; } catch { return [key, value]; }
      })) : options.body instanceof FormData ? options.body : JSON.parse(options.body);
      const result = await state.request(parsed.pathname.split('/').pop(), params, options.method);
      return { ok: true, status: 200, json: async () => ({ success: true, result }) };
    }
    assert.equal(options.headers.Authorization, config.apiKey);
    assert.equal(options.redirect, 'error');
    const bytes = state.badDownload ? Buffer.from('corrupt') : state.files.get(url);
    assert.ok(bytes);
    return { ok: true, arrayBuffer: async () => bytes };
  };
  return { dir, config, plans, state, close: () => fs.rmSync(dir, { force: true, recursive: true }) };
}

async function prepare(f, replaceLegacy = true) {
  const prepared = await prepareCsvOnly(f.plans, f.config, f.state.request, { replaceLegacy });
  const backup = await backupCsvOnly(prepared, f.config, f.state.request, f.state.fetchImpl, path.join(f.dir, 'backups'));
  return { prepared, backupPath: backup };
}

test('両CSVを同じURLで更新・検証してから画像とJSONを削除し、再実行時はCSVだけ再利用する', async () => {
  const f = fixture();
  try {
    const { prepared, backupPath } = await prepare(f);
    const report = await publishCsvOnly(prepared, f.config, f.state.request, f.state.fetchImpl, { backupPath });
    assert.equal(report.csv.length, 2); assert.equal(report.deleted.length, 4);
    assert.ok(report.csv.every((item) => item.verified && item.fields === 9));
    assert.ok(f.state.datasets.every((dataset) => dataset.resources.length === 1 && dataset.resources[0].format === 'CSV'));
    const actions = f.state.calls.map((call) => call.action);
    assert.ok(actions.lastIndexOf('resource_patch') < actions.indexOf('resource_delete'));
    for (const plan of f.plans) {
      const text = fs.readFileSync(plan.local_path, 'utf8');
      assert.ok(text.includes('https://data.cocolab.jp/repot/'));
      assert.equal(text.split('\r\n')[0].replace(/^\uFEFF/, ''), 'id,timestamp,lat,lon,caption,image_url,created_at,updated_at,deleted_at');
      assert.equal(text.includes('data.bodik.jp'), false);
    }
    assert.ok(fs.existsSync(path.join(backupPath, 'before.json')));
    const next = await prepare(f);
    const again = await publishCsvOnly(next.prepared, f.config, f.state.request, f.state.fetchImpl, { backupPath: next.backupPath });
    assert.ok(again.csv.every((item) => item.action === 'reuse'));
    assert.equal(again.deleted.length, 0);
  } finally { f.close(); }
});

test('通常のsendはCSVのみ送信し、画像・JSONの送信と削除を行わない', async () => {
  const f = fixture();
  try {
    await run(['--send', '--csv-dir', f.dir], { env: { CKAN_API_KEY: 'test-only-key' }, fetchImpl: f.state.fetchImpl, stdout: { write() {} }, stderr: { write() {} } });
    assert.ok(f.state.calls.every((call) => !['datastore_create', 'datastore_upsert', 'resource_delete', 'datastore_search'].includes(call.action)));
    assert.ok(f.state.datasets.every((dataset) => dataset.resources.length === 3));
  } finally { f.close(); }
});

test('後半CSVの送信失敗・CSV取得不一致では、既存の画像・JSONを削除しない', async () => {
  for (const failure of ['second', 'download']) {
    const f = fixture();
    try {
      const { prepared, backupPath } = await prepare(f);
      if (failure === 'second') f.state.failCsv = true;
      else f.state.badDownload = true;
      await assert.rejects(publishCsvOnly(prepared, f.config, f.state.request, f.state.fetchImpl, { backupPath }));
      assert.ok(f.state.calls.every((call) => call.action !== 'resource_delete'));
    } finally { f.close(); }
  }
});

test('管理対象外CSV・他組織・画像ハッシュ不一致は最初の書き込み前に止まる', async () => {
  for (const failure of ['foreign', 'org', 'image']) {
    const f = fixture();
    try {
      if (failure === 'foreign') f.state.datasets[1].resources.at(-1).description = '別の利用者のCSV';
      if (failure === 'org') f.state.datasets[1].owner_org = 'another-org';
      if (failure === 'image') f.state.files.set(f.state.datasets[1].resources[1].url, Buffer.from('changed'));
      await assert.rejects(prepare(f));
      assert.ok(f.state.calls.every((call) => call.method === 'GET'));
    } finally { f.close(); }
  }
});

test('バックアップがない場合や、確認後にJSONが変更された場合は削除しない', async () => {
  const f = fixture();
  try {
    const { prepared, backupPath } = await prepare(f);
    await assert.rejects(publishCsvOnly(prepared, f.config, f.state.request, f.state.fetchImpl), /バックアップ/);
    f.state.changedJson = true;
    await assert.rejects(publishCsvOnly(prepared, f.config, f.state.request, f.state.fetchImpl, { backupPath }), /JSONの投稿が変更/);
    assert.ok(f.state.calls.every((call) => call.action !== 'resource_delete'));
  } finally { f.close(); }
});
