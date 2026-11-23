#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { buildImagePlan, prepareImageUploads, uploadImages, attachImageUrls } = require('./lib/odcs_images');
const { writeCsvFile } = require('./lib/odcs_csv');
const { assertRecordFields, assertTableFields, imageFilename } = require('./lib/odcs_schema');

const ARCHIVE_DIR = path.resolve(__dirname, '../../docs/data/archives');
const DEFAULT_RESOURCE_ID = '8732b437-2134-445d-9a6b-461f02743c83';
const TARGETS = {
  komaruKurage: ['困クラゲ', 'クラゲ'],
  chushikokuSakana: ['中四国魚', '魚'],
};
const TARGET_ENV_SUFFIXES = { komaruKurage: 'KOMARU_KURAGE', chushikokuSakana: 'CHUSHIKOKU_SAKANA' };

function parseArgs(argv) {
  const args = { targets: [], send: false, dryRun: false, csvDir: '', output: '', help: false, replaceLegacy: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--send') args.send = true;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--upload-csv') { /* 旧コマンドとの互換用。現在は常にCSVのみ。 */ }
    else if (token === '--replace-legacy') args.replaceLegacy = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else if (['--upload-images', '--insert-only', '--force'].includes(token)) {
      throw new Error(`${token} は対応終了しました。画像・JSONは送信せず、CSVのみを扱います。`);
    } else if (['--target', '--output', '--csv-dir'].includes(token)) {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error(`${token} の値が必要です。`);
      if (token === '--output') args.output = value;
      else if (token === '--csv-dir') args.csvDir = value;
      else if (Object.hasOwn(TARGETS, value)) args.targets.push(value);
      else throw new Error(`対象外です: ${value}（${Object.keys(TARGETS).join(', ')}）`);
    } else throw new Error(`不明な引数です: ${token}`);
  }
  if (args.send && args.dryRun) throw new Error('--send と --dry-run は同時に指定できません。');
  args.targets = [...new Set(args.targets.length ? args.targets : Object.keys(TARGETS))];
  return args;
}

function loadConfig(env) {
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'datasets.json'), 'utf8'));
  const baseUrl = new URL(env.CKAN_BASE_URL || 'https://data.bodik.jp');
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('CKAN_BASE_URL は認証情報・クエリ・フラグメントを含まない HTTPS URL を指定してください。');
  }
  const imageBaseUrl = new URL(env.ODCS_IMAGE_BASE_URL || 'https://data.cocolab.jp/repot/');
  if (!['https:', 'http:'].includes(imageBaseUrl.protocol) || imageBaseUrl.search || imageBaseUrl.hash) {
    throw new Error('ODCS_IMAGE_BASE_URL は画像ディレクトリの HTTP(S) URL を指定してください。');
  }
  return {
    baseUrl: baseUrl.href.replace(/\/+$/, ''),
    apiKey: env.CKAN_API_KEY || '',
    resourceId: env.CKAN_RESOURCE_ID || DEFAULT_RESOURCE_ID,
    definitions: Object.fromEntries(Object.entries(registry.targets).map(([target, definition]) => [target, {
      ...definition, csv_resource_id: env[`CKAN_CSV_RESOURCE_ID_${TARGET_ENV_SUFFIXES[target]}`] || definition.csv_resource_id || '',
    }])),
    ownerOrg: registry.owner_org,
    resourceIds: Object.fromEntries(Object.entries(TARGET_ENV_SUFFIXES).map(([target, suffix]) => [
      target, env[`CKAN_RESOURCE_ID_${suffix}`] || registry.targets[target].legacy_table_resource_id || registry.targets[target].resource_id || '',
    ])),
    datasetIds: Object.fromEntries(Object.entries(TARGET_ENV_SUFFIXES).map(([target, suffix]) => [
      target, env[`CKAN_PACKAGE_ID_${suffix}`] || registry.targets[target].dataset_id || '',
    ])),
    imageBaseUrl: `${imageBaseUrl.href.replace(/\/+$/, '')}/`,
    imageDir: path.resolve(env.ODCS_IMAGE_DIR || path.join(__dirname, '../archive_photo')),
    csvDir: path.join(__dirname, 'output'),
  };
}

function buildUploadPlans(targets, config, args = {}) {
  const plans = targets.map((target) => {
    const resourceId = config.resourceIds[target];
    const result = buildPayload([target], { ...config, resourceId: resourceId || null });
    if (args.insertOnly) result.payload.method = 'insert';
    if (args.force) result.payload.force = true;
    return {
      target, dataset_id: config.datasetIds[target] || null, ...result,
      images: args.uploadImages ? buildImagePlan(result.payload, config.imageDir, config.definitions[target]) : undefined,
    };
  });
  const ids = plans.map((plan) => plan.payload.resource_id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error('魚とクラゲには別々の resource_id を指定してください。');
  const datasets = plans.map((plan) => plan.dataset_id).filter(Boolean);
  if (new Set(datasets).size !== datasets.length) throw new Error('魚とクラゲには別々のデータセットを指定してください。');
  return plans;
}

// エクスポーターが生成した JSON 配列だけを読む。入力 JavaScript は実行しない。
function readArchive(target, archiveDir = ARCHIVE_DIR) {
  const file = path.join(archiveDir, `${target}.js`);
  const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  const declaration = `const archive_${target} = `;
  const suffix = `;\nexport default archive_${target};`;
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(declaration) || !normalized.endsWith(suffix)) {
    throw new Error(`${file}: アーカイブの形式が想定と異なります。`);
  }
  const posts = JSON.parse(normalized.slice(declaration.length, -suffix.length));
  if (!Array.isArray(posts)) throw new Error(`${file}: JSON 配列が必要です。`);
  return posts;
}

function stableId(slug) {
  // 元データには数値 ID がない。投稿 slug から、正の PostgreSQL int4 内の ID を作る。
  // 分類や配列順序には依存しない。同一入力内と送信先との衝突は別途検査する。
  const hash = createHash('sha256').update(`repot:${slug}`).digest().readUInt32BE(0);
  return 1_000_000_000 + (hash % 1_147_483_648);
}

function mapRecord(post, target, config) {
  if (!post || typeof post !== 'object' || Array.isArray(post)) throw new Error('投稿はオブジェクトである必要があります。');
  if (typeof post.slug !== 'string' || !post.slug.trim()) throw new Error('slug がありません。');
  if (!Number.isSafeInteger(post.timestamp) || !Number.isFinite(new Date(post.timestamp * 1000).getTime())) {
    throw new Error(`${post.slug}: timestamp は UTC epoch 秒の整数が必要です。`);
  }
  if (typeof post.filename !== 'string' || !post.filename || /[\\/]/.test(post.filename) || /^\.{1,2}$/.test(post.filename)) {
    throw new Error(`${post.slug}: filename が不正です。`);
  }
  if (post.caption != null && typeof post.caption !== 'string') throw new Error(`${post.slug}: caption が不正です。`);

  const lat = post.location_lat;
  const lon = post.location_lng;
  if (lat == null || lon == null || (lat === -1 && lon === -1)) return null;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90
      || typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error(`${post.slug}: 緯度・経度が不正です。`);
  }

  const observedAt = new Date(post.timestamp * 1000).toISOString();
  return {
    id: stableId(post.slug),
    timestamp: post.timestamp,
    lat,
    lon,
    caption: post.caption ?? '',
    image_url: new URL(encodeURIComponent(post.filename), config.imageBaseUrl).href,
    created_at: observedAt,
    updated_at: observedAt,
    deleted_at: null,
  };
}

function buildPayload(targets, config, archiveDir = ARCHIVE_DIR) {
  const bySlug = new Map();
  const idOwners = new Map();
  const summaries = [];
  const skipped = [];
  for (const target of targets) {
    const posts = readArchive(target, archiveDir);
    let included = 0;
    for (const post of posts) {
      const record = mapRecord(post, target, config);
      if (!record) {
        skipped.push({ target, slug: post.slug, reason: '位置情報が欠損（null または -1, -1）' });
        continue;
      }
      included += 1;
      const idOwner = idOwners.get(record.id);
      if (idOwner && idOwner !== post.slug) throw new Error(`生成 ID が衝突しました: ${idOwner}, ${post.slug}`);
      idOwners.set(record.id, post.slug);
      const existing = bySlug.get(post.slug);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new Error(`同じ slug の投稿内容が一致しません: ${post.slug}`);
        }
      } else {
        bySlug.set(post.slug, record);
      }
    }
    summaries.push({ target, total: posts.length, included, skipped: posts.length - included });
  }
  const records = [...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, record]) => record);
  if (!records.length) throw new Error('送信可能な投稿がありません。');
  return { payload: { resource_id: config.resourceId, method: 'upsert', records }, summaries, skipped };
}

async function ckanRequest(action, params, config, fetchImpl, method = 'GET') {
  const url = new URL(`${config.baseUrl}/api/3/action/${action}`);
  const options = {
    method,
    headers: { Authorization: config.apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(params instanceof FormData ? 120_000 : 30_000),
    redirect: 'error',
  };
  if (method === 'GET') {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  } else if (params instanceof FormData) {
    // multipart の boundary は fetch に設定させる。
    options.body = params;
  } else {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(params);
  }
  let response;
  try {
    response = await fetchImpl(url.href, options);
  } catch (error) {
    throw new Error(`${action}: 通信に失敗しました（${error.message}）。POST の場合は反映済みの可能性があるため、送信先を確認してください。`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`${action}: HTTP ${response.status} / JSON 以外の応答です。POST の場合は送信先の反映状況を確認してください。`);
  }
  if (!response.ok || data?.success !== true) {
    const error = new Error(`${action}: HTTP ${response.status} / ${JSON.stringify(data?.error || data)}`);
    error.status = response.status;
    throw error;
  }
  return data.result;
}

async function validateDestinations(plans, config, fetchImpl) {
  if (!config.apiKey.trim()) throw new Error('CKAN_API_KEY が未設定です。');
  for (const plan of plans) {
    if (!plan.payload.resource_id || !plan.dataset_id) {
      throw new Error(`${plan.target}: 送信先の設定が必要です。setup_datasets.js を実行するか、分類別のデータセット ID / リソース ID を設定してください。`);
    }
  }
  const datasets = new Set();
  for (const plan of plans) {
    const resource = await ckanRequest('resource_show', { id: plan.payload.resource_id }, config, fetchImpl);
    if (resource?.package_id !== plan.dataset_id) throw new Error(`${plan.target}: 表データの所属データセットが設定と一致しません。`);
    if (datasets.has(resource.package_id)) throw new Error('魚とクラゲの送信先が同じデータセットです。');
    datasets.add(resource.package_id);
    // どちらかの設定に不備があれば、両方とも書き込み前に止める。
    await preflight(plan.payload, config, fetchImpl);
  }
}

async function verifyUniqueId(fields, resourceId, config, fetchImpl) {
  const keys = fields.filter((field) => field.id !== '_id' && field.schema?.uniquekey === true);
  if (keys.length === 1 && keys[0].id === 'id') return;
  if (!fields.find((field) => field.id === 'id')?.schema?.is_index) {
    throw new Error('upsert には id 単独の一意キーが必要です。新規追加のみなら --insert-only を指定してください。');
  }
  // 一部の CKAN は datastore_create の一意インデックスを uniquekey:false と返す。
  // インデックスがある表だけ、公式の dry_run で upsert が受理されることと
  // 検証用レコードがコミットされないことを確認する。force は使わない。
  const probeId = -2147483648;
  const query = { resource_id: resourceId, filters: { id: probeId }, fields: 'id', limit: 1 };
  const before = await ckanRequest('datastore_search', query, config, fetchImpl);
  if (before?.total !== 0) throw new Error('一意キーの検証用 ID が既に使用されています。');
  await ckanRequest('datastore_upsert', {
    resource_id: resourceId, method: 'upsert', dry_run: true, records: [{ id: probeId }],
  }, config, fetchImpl, 'POST');
  const after = await ckanRequest('datastore_search', query, config, fetchImpl);
  if (after?.total !== 0) throw new Error('一意キーのロールバック検証に失敗しました。');
}

async function preflight(payload, config, fetchImpl) {
  if (!['upsert', 'insert'].includes(payload.method)) throw new Error('未対応の登録方式です。');
  if (!Array.isArray(payload.records) || !payload.records.length) throw new Error('送信する投稿がありません。');
  payload.records.forEach(assertRecordFields);
  const identity = (record) => {
    if (!Number.isSafeInteger(Number(record.timestamp))) throw new Error('既存投稿の timestamp が不正です。');
    return JSON.stringify([Number(record.timestamp), imageFilename(record.image_url)]);
  };
  const byId = new Map();
  const byIdentity = new Map();
  for (const record of payload.records) {
    if (byId.has(String(record.id)) || byIdentity.has(identity(record))) throw new Error('送信する投稿の ID または日時・画像が重複しています。');
    byId.set(String(record.id), record);
    byIdentity.set(identity(record), record);
  }
  const info = await ckanRequest('datastore_info', { resource_id: payload.resource_id }, config, fetchImpl);
  assertTableFields(info?.fields);
  const fields = new Map(info.fields.map((field) => [field.id, field]));
  if (payload.method === 'upsert') await verifyUniqueId(info.fields, payload.resource_id, config, fetchImpl);
  if (['int2', 'smallint'].includes(fields.get('id').type)) throw new Error('送信先 id 列の型には int4 以上が必要です。');
  for (const field of info.fields) {
    if (field.schema?.notnull && payload.records.some((record) => Object.hasOwn(record, field.id) && record[field.id] === null)) {
      throw new Error(`送信先の ${field.id} 列は null を許可していません。`);
    }
  }

  for (let start = 0; start < payload.records.length; start += 100) {
    const batch = payload.records.slice(start, start + 100);
    // slug / source 列には依存しない。IDに加え、元の日時と画像名で同じ投稿か確認する。
    // ホスト変更や BODIK への画像アップロードでも画像名は維持される。
    for (const key of ['id', 'timestamp']) {
      const result = await ckanRequest('datastore_search', {
        resource_id: payload.resource_id,
        filters: { [key]: batch.map((record) => record[key]) },
        fields: 'id,timestamp,image_url',
        limit: 100,
        include_total: true,
      }, config, fetchImpl);
      if (!Array.isArray(result?.records) || !Number.isSafeInteger(result.total)
          || result.total !== result.records.length || result.records_truncated || result.total_was_estimated) {
        throw new Error('既存レコードの衝突確認が完了できませんでした。');
      }
      const seen = new Set();
      for (const row of result.records) {
        const expected = key === 'id' ? byId.get(String(row.id)) : byIdentity.get(identity(row));
        // 同じ秒に別の画像が投稿されることは許容する。
        if (key === 'timestamp' && !expected) continue;
        if (payload.method === 'insert') {
          throw new Error(`新規追加モードですが、同じ ID または日時・画像の投稿が既にあります。二重登録を防ぐため停止しました。`);
        }
        if (!expected || String(row.id) !== String(expected.id) || identity(row) !== identity(expected)) {
          throw new Error(`既存投稿と ID / 日時 / 画像が衝突しています: id=${row.id}`);
        }
        if (seen.has(String(row.id))) throw new Error(`送信先の ID が重複しています: ${row.id}`);
        seen.add(String(row.id));
      }
    }
  }
}

async function sendPayload(payload, config, fetchImpl, { images, onImage } = {}) {
  if (!config.apiKey.trim()) throw new Error('CKAN_API_KEY が未設定です。');
  await preflight(payload, config, fetchImpl);
  let finalPayload = payload;
  if (images) {
    const request = (action, params, method = 'GET') => ckanRequest(action, params, config, fetchImpl, method);
    const tasks = await prepareImageUploads(images, payload, config, request);
    const uploads = await uploadImages(tasks, config, request, onImage);
    finalPayload = attachImageUrls(payload, uploads);
    // 画像送信中に別処理が表を更新した可能性があるため、行の衝突を再確認する。
    await preflight(finalPayload, config, fetchImpl);
  }
  // 表データは最後に一度だけ書き込む。自動再試行・削除・スキーマ変更はしない。
  return ckanRequest('datastore_upsert', finalPayload, config, fetchImpl, 'POST');
}

async function run(argv, { env = process.env, fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write('使い方: node data/_bodik_odcs/upload_to_odcs.js [--dry-run | --send] [--target komaruKurage | --target chushikokuSakana] [--csv-dir directory] [--output plan.json] [--replace-legacy]\n通常実行は外部通信なしでCSVを生成します。送信するファイルはCSVのみです。--replace-legacy はCSVを検証した後、管理対象の旧画像・JSONをバックアップ付きで削除します。\n');
    return;
  }
  const { generateCsvPlans, prepareCsvOnly, backupCsvOnly, publishCsvOnly } = require('./lib/csv_only');
  const config = loadConfig(env);
  if (args.csvDir) config.csvDir = path.resolve(args.csvDir);
  const plans = generateCsvPlans(args.targets.map((target) => ({ target, dataset_id: config.datasetIds[target],
    ...buildPayload([target], { ...config, resourceId: undefined }),
  })), config.csvDir);
  const review = { type: 'repot-odcs-csv-only-plan-v1', image_base_url: config.imageBaseUrl,
    replace_legacy: args.replaceLegacy, datasets: plans.map((plan) => ({ target: plan.target, dataset_id: plan.dataset_id,
      csv_resource_id: config.definitions[plan.target].csv_resource_id || null, csv_path: plan.local_path,
      records: plan.payload.records.length, fields: 9, sha256: plan.sha256, summaries: plan.summaries, skipped: plan.skipped })) };
  const json = `${JSON.stringify(review, null, 2)}\n`;
  if (args.output) fs.writeFileSync(path.resolve(args.output), json, { flag: 'wx' });
  stderr.write(`${args.send ? 'SEND' : 'DRY RUN（外部通信なし）'}: CSVのみ / 画像URL: ${config.imageBaseUrl}\n`);
  for (const plan of plans) stderr.write(`${plan.target}: ${plan.payload.records.length} 件 / 9列 / ${plan.local_path}\n`);
  if (!args.send) {
    if (!args.output) stdout.write(json);
    return review;
  }
  if (!config.apiKey.trim()) throw new Error('CKAN_API_KEY が未設定です。');
  const request = (action, params, method = 'GET') => ckanRequest(action, params, config, fetchImpl, method);
  const prepared = await prepareCsvOnly(plans, config, request, { replaceLegacy: args.replaceLegacy });
  const backup = await backupCsvOnly(prepared, config, request, fetchImpl, path.join(config.csvDir, 'backups'));
  stderr.write(`バックアップ: ${backup}\n`);
  const reportPath = path.join(config.csvDir, 'csv_upload_report.json');
  const report = await publishCsvOnly(prepared, config, request, fetchImpl, { backupPath: backup,
    onProgress: (result) => writeCsvFile(reportPath, Buffer.from(`${JSON.stringify(result, null, 2)}\n`)) });
  for (const result of report.csv) stdout.write(`CSV ${result.action}: ${result.target} ${result.records} 件 / ${result.url}\n`);
  stdout.write(`旧リソース削除: ${report.deleted.length} 件\n`);
  return report;
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    const message = process.env.CKAN_API_KEY ? error.message.replaceAll(process.env.CKAN_API_KEY, '[redacted]') : error.message;
    console.error(`実行失敗: ${message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, loadConfig, readArchive, stableId, mapRecord, buildPayload, buildUploadPlans, validateDestinations, verifyUniqueId, ckanRequest, sendPayload, run };
