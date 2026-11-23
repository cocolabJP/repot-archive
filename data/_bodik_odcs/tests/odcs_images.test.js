'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, mapRecord, buildUploadPlans, sendPayload, run } = require('../upload_to_odcs');
const { buildImagePlan, imageReviewPlan } = require('../lib/odcs_images');

const config = { ...loadConfig({}), apiKey: 'test-only-key' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=', 'base64');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odcs-images-'));
  const filenames = ['one.png', 'two.png'];
  const records = filenames.map((filename, index) => mapRecord({
    slug: `post-${index}`, filename, timestamp: 1745721236 + index,
    location_lat: 34, location_lng: 134, caption: '',
  }, 'komaruKurage', config));
  for (const filename of filenames) fs.writeFileSync(path.join(dir, filename), png);
  const payload = { resource_id: config.resourceId, method: 'upsert', records };
  return { dir, payload, images: buildImagePlan(payload, dir), close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function mockServer(payload) {
  const table = { id: payload.resource_id, name: 'demo.csv', package_id: 'test-dataset' };
  const state = { resources: [table], calls: [], rows: [], failCreate: 0, createAttempts: 0, badSchema: false };
  let nextId = 1;
  state.fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const action = url.pathname.split('/').pop();
    state.calls.push({ action, options });
    assert.equal(options.headers.Authorization, 'test-only-key');
    let result;
    if (action === 'datastore_info') {
      result = { fields: Object.keys(payload.records[0]).map((id) => ({
        id, type: 'text', schema: { uniquekey: id === 'id' && !state.badSchema },
      })) };
    } else if (action === 'datastore_search') {
      const filters = JSON.parse(url.searchParams.get('filters'));
      const [key] = Object.keys(filters);
      const records = (state.rows.at(-1)?.records || []).filter((row) => filters[key].includes(row[key]));
      result = { records, total: records.length };
    } else if (action === 'resource_show') {
      assert.equal(url.searchParams.get('id'), table.id);
      result = table;
    } else if (action === 'package_show') {
      assert.equal(url.searchParams.get('id'), table.package_id);
      result = { id: table.package_id, resources: state.resources };
    } else if (action === 'resource_create' || action === 'resource_patch') {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], undefined);
      assert.ok(options.body instanceof FormData);
      const form = options.body;
      const file = form.get('upload');
      assert.equal(file.type, 'image/png');
      assert.ok((await file.arrayBuffer()).byteLength > 0);
      if (action === 'resource_create') {
        state.createAttempts += 1;
        if (state.createAttempts === state.failCreate) {
          return { ok: false, status: 403, json: async () => ({ success: false, error: { message: 'mock upload failed' } }) };
        }
        assert.equal(form.get('package_id'), table.package_id);
        result = { id: `test-image-${nextId++}`, package_id: table.package_id, url_type: 'upload' };
        state.resources.push(result);
      } else {
        result = state.resources.find((item) => item.id === form.get('id'));
        assert.ok(result);
      }
      for (const key of ['name', 'description', 'format', 'mimetype', 'hash']) result[key] = form.get(key);
      result.url = `https://data.bodik.jp/dataset/test-dataset/resource/${result.id}/download/${file.name}`;
    } else if (action === 'datastore_upsert') {
      const sent = JSON.parse(options.body);
      state.rows.push(sent);
      result = sent;
    } else {
      assert.fail(`unexpected API: ${action}`);
    }
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  return state;
}

test('ローカル画像を重複なく検証し、URL 未確定の確認用計画を生成する', () => {
  const f = fixture();
  try {
    const duplicated = { ...f.payload, records: [...f.payload.records, { ...f.payload.records[0], id: 3 }] };
    assert.equal(buildImagePlan(duplicated, f.dir).length, 2);
    assert.match(f.images[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(f.images[0].size, png.length);
    const review = imageReviewPlan(f.payload, f.images);
    assert.equal(review.type, 'repot-odcs-image-upload-plan-v1');
    assert.ok(review.payload.records.every((record) => record.image_url === null));
    assert.equal(f.payload.records[0].image_url, 'https://data.cocolab.jp/repot/one.png');
    fs.writeFileSync(path.join(f.dir, 'one.png'), '画像ではないデータ');
    assert.throws(() => buildImagePlan(f.payload, f.dir), /画像の形式/);
  } finally { f.close(); }
});

test('移行用の既存画像計画はローカル検証だけで生成できる', () => {
  const plans = buildUploadPlans(['komaruKurage', 'chushikokuSakana'], config, { uploadImages: true });
  assert.ok(plans.every((plan) => plan.images.length === plan.payload.records.length));
});

test('旧画像送信オプションはAPI呼び出しより前に止まる', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odcs-missing-images-'));
  try {
    await assert.rejects(run(['--upload-images', '--send'], {
      env: { CKAN_API_KEY: 'test-only-key', ODCS_IMAGE_DIR: dir },
      fetchImpl: async () => assert.fail('外部通信禁止'),
      stdout: { write() {} }, stderr: { write() {} },
    }), /CSVのみ/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('模擬 API で画像を先に保存し、返された URL を表へ登録する。再送時は画像を再利用する', async () => {
  const f = fixture();
  const server = mockServer(f.payload);
  try {
    await sendPayload(f.payload, config, server.fetchImpl, { images: f.images });
    assert.equal(server.resources.length, 3);
    assert.equal(server.rows.length, 1);
    const actions = server.calls.map((call) => call.action);
    assert.ok(actions.indexOf('datastore_info') < actions.indexOf('resource_create'));
    assert.ok(actions.lastIndexOf('resource_create') < actions.lastIndexOf('datastore_info'));
    assert.equal(actions.at(-1), 'datastore_upsert');
    assert.ok(server.rows[0].records.every((record) => record.image_url.startsWith('https://data.bodik.jp/dataset/')));
    assert.ok(server.rows[0].records.every((record) => Object.keys(record).length === 9 && !('filename' in record) && !('_id' in record)));
    assert.equal(f.payload.records[0].image_url, 'https://data.cocolab.jp/repot/one.png');
    await sendPayload(f.payload, config, server.fetchImpl, { images: f.images });
    assert.equal(server.resources.length, 3);
    assert.equal(server.createAttempts, 2);
    assert.deepEqual(server.rows[1], server.rows[0]);
  } finally { f.close(); }
});

test('内容が変わった画像だけ resource_patch で更新し、リソース ID を維持する', async () => {
  const f = fixture();
  const server = mockServer(f.payload);
  try {
    await sendPayload(f.payload, config, server.fetchImpl, { images: f.images });
    const before = server.resources[1].id;
    fs.writeFileSync(path.join(f.dir, 'one.png'), Buffer.concat([png, Buffer.from([0])]));
    const updated = buildImagePlan(f.payload, f.dir);
    await sendPayload(f.payload, config, server.fetchImpl, { images: updated });
    assert.equal(server.calls.filter((call) => call.action === 'resource_patch').length, 1);
    assert.equal(server.resources[1].id, before);
    assert.equal(server.createAttempts, 2);
    assert.equal(server.resources[1].hash, updated[0].sha256);
  } finally { f.close(); }
});

test('途中の画像送信に失敗した場合は表を更新せず、再実行で成功済み画像を再利用する', async () => {
  const f = fixture();
  const server = mockServer(f.payload);
  server.failCreate = 2;
  try {
    await assert.rejects(sendPayload(f.payload, config, server.fetchImpl, { images: f.images }), /mock upload failed/);
    assert.equal(server.rows.length, 0);
    assert.equal(server.resources.length, 2);
    await sendPayload(f.payload, config, server.fetchImpl, { images: f.images });
    assert.equal(server.resources.length, 3);
    assert.equal(server.rows.length, 1);
    assert.equal(server.createAttempts, 3);
  } finally { f.close(); }
});

test('後半の画像の同名衝突も、最初の画像 POST より前に検出する', async () => {
  const f = fixture();
  const server = mockServer(f.payload);
  server.resources.push({
    id: 'foreign-image', package_id: 'test-dataset', url_type: 'upload',
    name: f.images[1].name, description: '別の利用者が登録したファイル', url: 'https://data.bodik.jp/other.png',
  });
  try {
    await assert.rejects(sendPayload(f.payload, config, server.fetchImpl, { images: f.images }), /管理対象外/);
    assert.equal(server.createAttempts, 0);
    assert.equal(server.rows.length, 0);
  } finally { f.close(); }
});

test('表の事前検証失敗・計画後の画像変更では画像を POST しない', async () => {
  const f = fixture();
  const server = mockServer(f.payload);
  try {
    server.badSchema = true;
    await assert.rejects(sendPayload(f.payload, config, server.fetchImpl, { images: f.images }), /一意キー/);
    assert.ok(server.calls.every((call) => call.options.method === 'GET'));
    server.badSchema = false;
    fs.writeFileSync(path.join(f.dir, 'one.png'), '変更');
    await assert.rejects(sendPayload(f.payload, config, server.fetchImpl, { images: f.images }), /検証後に画像が変更/);
    assert.equal(server.createAttempts, 0);
    assert.equal(server.rows.length, 0);
  } finally { f.close(); }
});
