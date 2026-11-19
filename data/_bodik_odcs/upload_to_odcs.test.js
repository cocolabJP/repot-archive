'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, loadConfig, readArchive, stableId, mapRecord, buildPayload, buildUploadPlans, validateDestinations, verifyUniqueId, sendPayload, run } = require('./upload_to_odcs');

const config = loadConfig({});
const post = {
  slug: '20250427113356_7c7ed', timestamp: 1745721236, filename: '20250427113356_7c7ed.png',
  caption: null, location_lat: 34.5638272138, location_lng: 134.0994501659, location_alt: 0,
  hashtag_names: ['クラゲ', '＃海'], caution_flag: false,
};
const record = mapRecord(post, 'komaruKurage', config);
const payload = { resource_id: config.resourceId, method: 'upsert', records: [record] };
const sink = { write() {} };

function mockCkan({ existing = [], changeInfo, errorAction, malformedAction } = {}) {
  const calls = [];
  const fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const action = url.pathname.split('/').pop();
    calls.push({ action, options, url });
    assert.equal(options.headers.Authorization, 'test-only-key');
    assert.equal(options.redirect, 'error');
    if (malformedAction === action) return { ok: true, status: 200, json: async () => { throw new Error('invalid JSON'); } };
    let result = {};
    if (action === 'datastore_info') {
      result = { fields: Object.keys(record).map((id) => ({
        id, type: id === 'id' ? 'int4' : 'text', schema: { uniquekey: id === 'id', notnull: false },
      })) };
      if (changeInfo) changeInfo(result);
    } else if (action === 'datastore_search') {
      assert.equal(options.method, 'GET');
      const filters = JSON.parse(url.searchParams.get('filters'));
      const key = Object.keys(filters)[0];
      const records = existing.filter((item) => filters[key].map(String).includes(String(item[key])));
      result = { records, total: records.length };
    } else {
      assert.equal(action, 'datastore_upsert');
      assert.equal(options.method, 'POST');
      assert.ok(['upsert', 'insert'].includes(JSON.parse(options.body).method));
    }
    return { ok: true, status: 200, json: async () => errorAction === action
      ? { success: false, error: { message: 'mock failure' } } : { success: true, result } };
  };
  return { calls, fetchImpl };
}

test('実データの両方を読み、位置情報欠損の除外を報告する', () => {
  const targets = ['komaruKurage', 'chushikokuSakana'];
  const result = buildPayload(targets, config);
  assert.deepEqual(result.summaries.map((item) => item.target), targets);
  for (const item of result.summaries) {
    assert.equal(item.total, readArchive(item.target).length);
    assert.equal(item.total, item.included + item.skipped);
  }
  assert.equal(new Set(result.payload.records.map((item) => item.id)).size, result.payload.records.length);
  for (const item of result.payload.records) {
    assert.equal(item.source, 'repot');
    assert.notDeepEqual([item.lat, item.lon], [-1, -1]);
    assert.ok(item.tags.includes('#困クラゲ') || item.tags.includes('#中四国魚'));
    assert.equal(item.created_at, new Date(item.timestamp * 1000).toISOString());
    assert.equal('location_acc' in item, false);
  }
});

test('epoch 秒をそのまま保持し、タグ・画像 URL・欠損値を変換する', () => {
  assert.equal(record.timestamp, 1745721236);
  assert.equal(record.created_at, '2025-04-27T02:33:56.000Z');
  assert.equal(record.updated_at, record.created_at);
  assert.equal(record.caption, '');
  assert.equal(record.location_alt, '0');
  assert.equal(record.user_id, null);
  assert.equal(record.deleted_at, null);
  assert.equal(record.tags, '#困クラゲ #クラゲ #海');
  assert.equal(record.image_url, 'https://repot-archive.yukimat.jp/photo/20250427113356_7c7ed.png');
  const fish = mapRecord({ ...post, hashtag_names: [], caution_flag: true }, 'chushikokuSakana', config);
  assert.equal(fish.tags, '#中四国魚 #魚 #利用上の注意');
  assert.equal(fish.id, record.id);
  assert.equal(stableId(post.slug), record.id);
  assert.ok(record.id >= 1_000_000_000 && record.id <= 2_147_483_647);
});

test('欠損座標は除外し、不正な座標・日時・投稿は失敗する', () => {
  assert.equal(mapRecord({ ...post, location_lat: -1, location_lng: -1 }, 'komaruKurage', config), null);
  assert.equal(mapRecord({ ...post, location_lat: null }, 'komaruKurage', config), null);
  assert.equal(mapRecord({ ...post, location_lat: 0, location_lng: 0 }, 'komaruKurage', config).lat, 0);
  for (const patch of [{ location_lat: 91 }, { location_lng: '133' }, { timestamp: '1745721236' },
    { timestamp: NaN }, { slug: '' }, { filename: '../a.png' }, { hashtag_names: null }]) {
    assert.throws(() => mapRecord({ ...post, ...patch }, 'komaruKurage', config));
  }
});

test('同じ投稿を両方に含むときはタグを統合し、内容の不一致は停止する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odcs-test-'));
  const save = (target, value) => fs.writeFileSync(path.join(dir, `${target}.js`),
    `const archive_${target} = ${JSON.stringify([value])};\nexport default archive_${target};`);
  try {
    save('komaruKurage', post);
    save('chushikokuSakana', post);
    const result = buildPayload(['komaruKurage', 'chushikokuSakana'], config, dir);
    assert.equal(result.payload.records.length, 1);
    assert.equal(result.payload.records[0].tags, '#困クラゲ #クラゲ #海 #中四国魚 #魚');
    save('chushikokuSakana', { ...post, caption: '別の内容' });
    assert.throws(() => buildPayload(['komaruKurage', 'chushikokuSakana'], config, dir), /一致しません/);
    fs.appendFileSync(path.join(dir, 'komaruKurage.js'), '\nthrow new Error("実行してはいけない");');
    assert.throws(() => readArchive('komaruKurage', dir), /形式/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('通常実行・明示 dry-run は API キーがあっても外部通信しない', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('通信禁止'); };
  for (const argv of [[], ['--dry-run'], ['--target', 'chushikokuSakana'], ['--help']]) {
    await run(argv, { env: { CKAN_API_KEY: 'test-only-key' }, fetchImpl, stdout: sink, stderr: sink });
  }
  assert.equal(calls, 0);
  assert.throws(() => parseArgs(['--send', '--dry-run']), /同時/);
  assert.throws(() => parseArgs(['--send', '--unknown']), /不明/);
  assert.throws(() => parseArgs(['--target', 'other']), /対象外/);
  assert.throws(() => parseArgs(['--output', '--send']), /値が必要/);
});

test('payload の保存は有効な JSON で、既存ファイルは上書きしない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odcs-output-'));
  const file = path.join(dir, 'payload.json');
  try {
    const options = { env: {}, stdout: sink, stderr: sink, fetchImpl: async () => assert.fail('外部通信禁止') };
    await run(['--output', file], options);
    const output = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(output.datasets.length, 2);
    assert.ok(output.datasets.every((dataset) => dataset.payload.method === 'upsert'));
    await assert.rejects(run(['--output', file], options), /EEXIST/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('送信前にキー・列・一意キー・null 制約を検証し、不備があれば POST しない', async () => {
  const noKey = mockCkan();
  await assert.rejects(sendPayload(payload, config, noKey.fetchImpl), /CKAN_API_KEY/);
  assert.equal(noKey.calls.length, 0);
  const changes = [
    (info) => { info.fields = info.fields.filter((item) => item.id !== 'tags'); },
    (info) => { info.fields.find((item) => item.id === 'id').schema.uniquekey = false; },
    (info) => { info.fields.find((item) => item.id === 'user_id').schema.notnull = true; },
  ];
  for (const changeInfo of changes) {
    const mock = mockCkan({ changeInfo });
    await assert.rejects(sendPayload(payload, { ...config, apiKey: 'test-only-key' }, mock.fetchImpl));
    assert.ok(mock.calls.every((call) => call.options.method === 'GET'));
  }
});

test('既存データの ID・slug・source の衝突では POST しない', async () => {
  for (const existing of [
    [{ ...record, slug: 'other' }], [{ ...record, id: record.id + 1 }],
    [{ ...record, source: 'other' }], [record, record],
  ]) {
    const mock = mockCkan({ existing });
    await assert.rejects(sendPayload(payload, { ...config, apiKey: 'test-only-key' }, mock.fetchImpl), /衝突|重複/);
    assert.ok(mock.calls.every((call) => call.options.method === 'GET'));
  }
});

test('模擬 API では全事前確認後に一度だけ POST し、再送時も同じ ID を使う', async () => {
  for (const existing of [[], [record]]) {
    const mock = mockCkan({ existing });
    await sendPayload(payload, { ...config, apiKey: 'test-only-key' }, mock.fetchImpl);
    assert.deepEqual(mock.calls.map((call) => call.action),
      ['datastore_info', 'datastore_search', 'datastore_search', 'datastore_upsert']);
    assert.deepEqual(JSON.parse(mock.calls.at(-1).options.body), payload);
  }
});

test('新規追加モードは一意キー未設定の表に insert し、既存 id / slug があれば POST しない', async () => {
  const insertPayload = { ...payload, method: 'insert' };
  const options = { changeInfo: (info) => { info.fields.find((item) => item.id === 'id').schema.uniquekey = false; } };
  const fresh = mockCkan(options);
  await sendPayload(insertPayload, { ...config, apiKey: 'test-only-key' }, fresh.fetchImpl);
  assert.equal(JSON.parse(fresh.calls.at(-1).options.body).method, 'insert');
  for (const existing of [[record], [{ ...record, id: record.id + 1 }], [{ ...record, slug: 'other' }]]) {
    const mock = mockCkan({ ...options, existing });
    await assert.rejects(sendPayload(insertPayload, { ...config, apiKey: 'test-only-key' }, mock.fetchImpl), /二重登録/);
    assert.ok(mock.calls.every((call) => call.options.method === 'GET'));
  }
});

test('読み取り専用 DataStore への force は明示指定した場合だけ payload に入る', async () => {
  for (const force of [false, true]) {
    let output = '';
    await run(['--insert-only', '--dry-run', ...(force ? ['--force'] : [])], {
      env: {}, stdout: { write: (value) => { output += value; } }, stderr: sink,
      fetchImpl: async () => assert.fail('外部通信禁止'),
    });
    const data = JSON.parse(output);
    assert.ok(data.datasets.every((dataset) => dataset.payload.method === 'insert'));
    assert.ok(data.datasets.every((dataset) => dataset.payload.force === (force ? true : undefined)));
  }
  const mock = mockCkan();
  await sendPayload({ ...payload, method: 'insert', force: true }, { ...config, apiKey: 'test-only-key' }, mock.fetchImpl);
  assert.equal(JSON.parse(mock.calls.at(-1).options.body).force, true);
});

test('クラゲと魚の表・画像・送信先を分離し、同じデータセットの設定を拒否する', async () => {
  const env = { CKAN_API_KEY: 'test-only-key', CKAN_RESOURCE_ID_KOMARU_KURAGE: 'kurage-table',
    CKAN_RESOURCE_ID_CHUSHIKOKU_SAKANA: 'fish-table', CKAN_PACKAGE_ID_KOMARU_KURAGE: 'kurage-dataset',
    CKAN_PACKAGE_ID_CHUSHIKOKU_SAKANA: 'fish-dataset' };
  const cfg = loadConfig(env);
  const plans = buildUploadPlans(['komaruKurage', 'chushikokuSakana'], cfg, { uploadImages: true });
  assert.deepEqual(plans.map((plan) => plan.payload.resource_id), ['kurage-table', 'fish-table']);
  for (const plan of plans) {
    const slugs = new Set(readArchive(plan.target).map((post) => post.slug));
    assert.ok(plan.payload.records.every((record) => slugs.has(record.slug)));
    assert.deepEqual(new Set(plan.images.map((image) => image.filename)), new Set(plan.payload.records.map((record) => record.filename)));
  }
  assert.throws(() => buildUploadPlans(['komaruKurage', 'chushikokuSakana'],
    { ...cfg, datasetIds: { komaruKurage: 'same', chushikokuSakana: 'same' } }), /別々のデータセット/);
  const mock = mockCkan();
  const fetchImpl = (rawUrl, options) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/resource_show')) return Promise.resolve({ ok: true, status: 200,
      json: async () => ({ success: true, result: { package_id: url.searchParams.get('id') === 'kurage-table' ? 'kurage-dataset' : 'fish-dataset' } }) });
    return mock.fetchImpl(rawUrl, options);
  };
  await run(['--send'], { env, fetchImpl, stdout: sink, stderr: sink });
  const sent = mock.calls.filter((call) => call.options.method === 'POST').map((call) => JSON.parse(call.options.body));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((item) => item.resource_id), ['kurage-table', 'fish-table']);
  assert.ok(sent.every((item) => item.force === undefined));
  await assert.rejects(validateDestinations(plans, cfg, async () => ({ ok: true, status: 200,
    json: async () => ({ success: true, result: { package_id: 'wrong-dataset' } }) })), /所属データセット/);
});

test('CKAN の success:false・非 JSON 応答は失敗として扱い、再試行しない', async () => {
  for (const settings of [{ errorAction: 'datastore_upsert' }, { malformedAction: 'datastore_upsert' }]) {
    const mock = mockCkan(settings);
    await assert.rejects(sendPayload(payload, { ...config, apiKey: 'test-only-key' }, mock.fetchImpl));
    assert.equal(mock.calls.filter((call) => call.options.method === 'POST').length, 1);
  }
});

test('一意インデックスのメタデータ不足はロールバック検証し、検証行が残れば停止する', async () => {
  for (const persists of [false, true]) {
    const calls = [];
    let probed = false;
    const fetchImpl = async (rawUrl, options) => {
      const action = new URL(rawUrl).pathname.split('/').pop();
      calls.push(action);
      if (action === 'datastore_upsert') {
        const params = JSON.parse(options.body);
        assert.equal(params.dry_run, true);
        assert.equal(params.force, undefined);
        probed = true;
      }
      return { ok: true, status: 200, json: async () => ({ success: true,
        result: { total: probed && persists ? 1 : 0, records: [] } }) };
    };
    const check = verifyUniqueId([{ id: 'id', schema: { uniquekey: false, is_index: true } }], 'new-table',
      { ...config, apiKey: 'test-only-key' }, fetchImpl);
    if (persists) await assert.rejects(check, /ロールバック/);
    else await check;
    assert.deepEqual(calls, ['datastore_search', 'datastore_upsert', 'datastore_search']);
  }
});
