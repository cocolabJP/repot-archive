'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, mapRecord, parseArgs, run } = require('../upload_to_odcs');
const { CSV_FIELDS, serializeCsv, prepareCsvUpload, readCsvRecords, uploadCsv } = require('../lib/odcs_csv');
const { datasetMarker, csvMetadata } = require('../lib/metadata');

const config = { ...loadConfig({}), apiKey: 'test-only-key' };
const record = mapRecord({ slug: '20250427113356_7c7ed', timestamp: 1745721236, filename: 'one.png', caption: '日本語, "引用"\n次の行',
  location_lat: 0, location_lng: 0, location_alt: 0, hashtag_names: ['海'], caution_flag: false }, 'komaruKurage', config);

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odcs-csv-'));
  const plan = { target: 'komaruKurage', dataset_id: 'test-dataset', payload: { resource_id: 'test-table', method: 'upsert', records: [record] } };
  const state = { calls: [], resources: [{ id: 'test-table', package_id: 'test-dataset', name: 'JSON投稿表' }],
    records: [{ ...record, image_url: 'https://data.bodik.jp/photo/one.png' }], files: new Map(), badDownload: false };
  state.request = async (action, params, method = 'GET') => {
    state.calls.push({ action, params, method });
    if (action === 'package_show') return { id: plan.dataset_id, notes: datasetMarker(plan.target), resources: state.resources };
    if (action === 'datastore_search') {
      assert.equal(params.fields, CSV_FIELDS.join(','));
      return { records: state.records.slice(Number(params.offset), Number(params.offset) + 1), total: state.records.length };
    }
    assert.ok(['resource_create', 'resource_patch'].includes(action));
    assert.equal(method, 'POST');
    assert.ok(params instanceof FormData);
    assert.equal(params.get('format'), 'CSV');
    const file = params.get('upload');
    assert.equal(file.name, 'komaruKurage.csv');
    assert.equal(file.type, 'text/csv');
    let resource = state.resources.find((resource) => resource.id === params.get('id'));
    if (action === 'resource_create') {
      assert.equal(params.get('package_id'), plan.dataset_id);
      resource = { id: 'test-csv', package_id: plan.dataset_id, url_type: 'upload', format: 'CSV', url: 'https://data.bodik.jp/csv/komaruKurage.csv' };
      state.resources.push(resource);
    }
    for (const key of ['name', 'description']) {
      // multipart のテキスト項目は転送時に改行が CRLF に正規化される。
      resource[key] = key === 'description' ? params.get(key).replace(/\r?\n/g, '\r\n') : params.get(key);
    }
    state.files.set(resource.url, Buffer.from(await file.arrayBuffer()));
    return resource;
  };
  state.fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, config.apiKey);
    const bytes = state.badDownload ? Buffer.from('unexpected body') : state.files.get(url);
    return { ok: true, arrayBuffer: async () => bytes };
  };
  return { directory, plan, state, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('CSVは17列を同じ順序で保持し、BOM・CRLF・引用符・カンマ・改行・nullを扱う', () => {
  assert.deepEqual(CSV_FIELDS, Object.keys(record));
  const bytes = serializeCsv([record]);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  assert.ok(text.startsWith('\uFEFF' + CSV_FIELDS.join(',') + '\r\n'));
  assert.ok(text.includes('"日本語, ""引用""\n次の行"'));
  assert.ok(text.includes(',0,0,0,confirmed,'));
  assert.ok(text.endsWith(',\r\n'));
  assert.ok(!text.includes('null'));
  assert.throws(() => serializeCsv([{ ...record, lat: NaN }]), /出力できない/);
  const missing = { ...record }; delete missing.slug;
  assert.throws(() => serializeCsv([missing]), /必要な項目/);
});

test('CSVはJSON投稿表の全件をページ取得し、今回送信した分以外の既存投稿も含める', async () => {
  const f = fixture();
  f.state.records.push({ ...record, id: record.id + 1, slug: 'older-post', filename: 'older.png' });
  try {
    const rows = await readCsvRecords(f.plan.payload.resource_id, f.state.request);
    assert.equal(rows.length, 2);
    assert.equal(f.state.calls.filter((call) => call.action === 'datastore_search').length, 2);
    assert.ok(rows.every((row) => !Object.hasOwn(row, '_id')));
  } finally { f.close(); }
});

test('CSVを新規登録・再利用・同じIDで更新し、取得したバイト列まで確認する', async () => {
  const f = fixture();
  const upload = async () => uploadCsv(await prepareCsvUpload(f.plan, config, f.state.request), config, f.state.request, f.state.fetchImpl, f.directory);
  try {
    const created = await upload();
    assert.equal(created.action, 'create');
    assert.equal(created.records, 1);
    assert.ok(fs.readFileSync(created.local_path, 'utf8').includes('https://data.bodik.jp/photo/one.png'));
    const reused = await upload();
    assert.equal(reused.action, 'reuse');
    assert.equal(f.state.calls.filter((call) => call.method === 'POST').length, 1);
    f.state.records[0].caption = '更新後のコメント';
    const updated = await upload();
    assert.equal(updated.action, 'update');
    assert.equal(updated.resource_id, created.resource_id);
    assert.equal(f.state.resources.length, 2);
    assert.equal(f.state.calls.filter((call) => call.action === 'resource_create').length, 1);
    assert.equal(f.state.calls.filter((call) => call.action === 'resource_patch').length, 1);
  } finally { f.close(); }
});

test('同名の管理対象外CSVは上書きせず、登録前に停止する', async () => {
  const f = fixture();
  f.state.resources.push({ id: 'foreign-csv', package_id: f.plan.dataset_id, format: 'CSV', url_type: 'upload',
    name: csvMetadata(f.plan.target, config.definitions[f.plan.target], {}).name, description: '別の利用者のCSV' });
  try {
    await assert.rejects(prepareCsvUpload(f.plan, config, f.state.request), /管理対象外/);
    assert.ok(f.state.calls.every((call) => call.method === 'GET'));
  } finally { f.close(); }
});

test('CSV用データの重複・ページ間の件数変化・アップロード後の不一致を検知する', async () => {
  const f = fixture();
  try {
    f.state.records.push({ ...f.state.records[0] });
    await assert.rejects(readCsvRecords(f.plan.payload.resource_id, f.state.request), /IDが重複/);
    let calls = 0;
    await assert.rejects(readCsvRecords('table', async () => ({ total: ++calls === 1 ? 2 : 3, records: [record] })), /全件取得/);
    f.state.records.pop();
    f.state.badDownload = true;
    await assert.rejects(uploadCsv(await prepareCsvUpload(f.plan, config, f.state.request), config,
      f.state.request, f.state.fetchImpl, f.directory), /生成ファイルと一致/);
  } finally { f.close(); }
});

test('CSVのdry-runは実サーバーに接続せず、分類ごとのプレビューを生成する', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odcs-csv-preview-'));
  try {
    let output = '';
    await run(['--upload-csv', '--upload-images', '--dry-run', '--csv-dir', directory], {
      env: {}, stdout: { write: (value) => { output += value; } }, stderr: { write() {} },
      fetchImpl: async () => assert.fail('通信禁止'),
    });
    const plan = JSON.parse(output);
    assert.equal(plan.datasets.length, 2);
    for (const dataset of plan.datasets) {
      assert.ok(fs.existsSync(dataset.csv.preview_path));
      assert.ok(fs.readFileSync(dataset.csv.preview_path, 'utf8').includes('image_url'));
      assert.ok(!fs.readFileSync(dataset.csv.preview_path, 'utf8').includes('https://repot-archive.yukimat.jp/photo/'));
    }
    assert.throws(() => parseArgs(['--csv-dir', directory]), /一緒に/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
