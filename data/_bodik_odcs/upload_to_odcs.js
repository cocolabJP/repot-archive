#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { buildImagePlan, prepareImageUploads, uploadImages, attachImageUrls, imageReviewPlan } = require('./lib/odcs_images');
const { writeCsvPreview, prepareCsvUpload, uploadCsv, writeCsvFile } = require('./lib/odcs_csv');

const ARCHIVE_DIR = path.resolve(__dirname, '../../docs/data/archives');
const DEFAULT_RESOURCE_ID = '8732b437-2134-445d-9a6b-461f02743c83';
const TARGETS = {
  komaruKurage: ['困クラゲ', 'クラゲ'],
  chushikokuSakana: ['中四国魚', '魚'],
};
const TARGET_ENV_SUFFIXES = { komaruKurage: 'KOMARU_KURAGE', chushikokuSakana: 'CHUSHIKOKU_SAKANA' };

function parseArgs(argv) {
  const args = { targets: [], send: false, dryRun: false, uploadImages: false, uploadCsv: false, csvDir: '', insertOnly: false, force: false, output: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--send') args.send = true;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--upload-images') args.uploadImages = true;
    else if (token === '--upload-csv') args.uploadCsv = true;
    else if (token === '--insert-only') args.insertOnly = true;
    else if (token === '--force') args.force = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--target' || token === '--output' || token === '--csv-dir') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error(`${token} の値が必要です。`);
      if (token === '--output') args.output = value;
      else if (token === '--csv-dir') args.csvDir = value;
      else if (Object.hasOwn(TARGETS, value)) args.targets.push(value);
      else throw new Error(`対象外です: ${value}（${Object.keys(TARGETS).join(', ')}）`);
    } else {
      throw new Error(`不明な引数です: ${token}`);
    }
  }
  if (args.send && args.dryRun) throw new Error('--send と --dry-run は同時に指定できません。');
  if (args.csvDir && !args.uploadCsv) throw new Error('--csv-dir は --upload-csv と一緒に指定してください。');
  args.targets = [...new Set(args.targets.length ? args.targets : Object.keys(TARGETS))];
  return args;
}

function loadConfig(env) {
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'datasets.json'), 'utf8'));
  const baseUrl = new URL(env.CKAN_BASE_URL || 'https://data.bodik.jp');
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('CKAN_BASE_URL は認証情報・クエリ・フラグメントを含まない HTTPS URL を指定してください。');
  }
  const imageBaseUrl = new URL(env.ODCS_IMAGE_BASE_URL || 'https://repot-archive.yukimat.jp/photo/');
  if (!['https:', 'http:'].includes(imageBaseUrl.protocol) || imageBaseUrl.search || imageBaseUrl.hash) {
    throw new Error('ODCS_IMAGE_BASE_URL は画像ディレクトリの HTTP(S) URL を指定してください。');
  }
  return {
    baseUrl: baseUrl.href.replace(/\/+$/, ''),
    apiKey: env.CKAN_API_KEY || '',
    resourceId: env.CKAN_RESOURCE_ID || DEFAULT_RESOURCE_ID,
    definitions: registry.targets,
    resourceIds: Object.fromEntries(Object.entries(TARGET_ENV_SUFFIXES).map(([target, suffix]) => [
      target, env[`CKAN_RESOURCE_ID_${suffix}`] || registry.targets[target].resource_id || '',
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

function normalizeTags(tags) {
  return [...new Set(tags.map((tag) => {
    if (typeof tag !== 'string') throw new Error('ハッシュタグは文字列である必要があります。');
    return tag.trim().replace(/^[#＃]+/, '');
  }).filter(Boolean))].map((tag) => `#${tag}`).join(' ');
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
  if (!Array.isArray(post.hashtag_names)) throw new Error(`${post.slug}: hashtag_names は配列が必要です。`);
  if (typeof post.caution_flag !== 'boolean') throw new Error(`${post.slug}: caution_flag は真偽値が必要です。`);
  if (post.location_alt != null && (typeof post.location_alt !== 'number' || !Number.isFinite(post.location_alt))) {
    throw new Error(`${post.slug}: location_alt が不正です。`);
  }

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
    user_id: null,
    slug: post.slug,
    timestamp: post.timestamp,
    lat,
    lon,
    location_alt: post.location_alt == null ? '' : String(post.location_alt),
    status: 'confirmed',
    caption: post.caption ?? '',
    tags: normalizeTags([...TARGETS[target], ...post.hashtag_names, ...(post.caution_flag ? ['利用上の注意'] : [])]),
    species: '',
    filename: post.filename,
    image_url: new URL(encodeURIComponent(post.filename), config.imageBaseUrl).href,
    source: 'repot',
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
      if (idOwner && idOwner !== record.slug) throw new Error(`生成 ID が衝突しました: ${idOwner}, ${record.slug}`);
      idOwners.set(record.id, record.slug);
      const existing = bySlug.get(record.slug);
      if (existing) {
        const { tags: previousTags, ...previousFields } = existing;
        const { tags: currentTags, ...currentFields } = record;
        if (JSON.stringify(previousFields) !== JSON.stringify(currentFields)) {
          throw new Error(`同じ slug の投稿内容が一致しません: ${record.slug}`);
        }
        existing.tags = normalizeTags([...previousTags.split(' '), ...currentTags.split(' ')]);
      } else {
        bySlug.set(record.slug, record);
      }
    }
    summaries.push({ target, total: posts.length, included, skipped: posts.length - included });
  }
  const records = [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
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
  const info = await ckanRequest('datastore_info', { resource_id: payload.resource_id }, config, fetchImpl);
  if (!Array.isArray(info?.fields)) throw new Error('送信先の列情報が取得できませんでした。');
  const fields = new Map(info.fields.map((field) => [field.id, field]));
  const missing = Object.keys(payload.records[0]).filter((name) => !fields.has(name));
  if (missing.length) throw new Error(`送信先に列がありません: ${missing.join(', ')}`);
  if (payload.method === 'upsert') await verifyUniqueId(info.fields, payload.resource_id, config, fetchImpl);
  if (['int2', 'smallint'].includes(fields.get('id').type)) throw new Error('送信先 id 列の型には int4 以上が必要です。');
  for (const field of info.fields) {
    if (field.schema?.notnull && payload.records.some((record) => Object.hasOwn(record, field.id) && record[field.id] === null)) {
      throw new Error(`送信先の ${field.id} 列は null を許可していません。`);
    }
  }

  const byId = new Map(payload.records.map((record) => [String(record.id), record]));
  const bySlug = new Map(payload.records.map((record) => [record.slug, record]));
  for (let start = 0; start < payload.records.length; start += 100) {
    const batch = payload.records.slice(start, start + 100);
    for (const key of ['id', 'slug']) {
      const result = await ckanRequest('datastore_search', {
        resource_id: payload.resource_id,
        filters: { [key]: batch.map((record) => record[key]) },
        fields: 'id,slug,source',
        limit: 100,
        include_total: true,
      }, config, fetchImpl);
      if (!Array.isArray(result?.records) || !Number.isSafeInteger(result.total)
          || result.total !== result.records.length || result.records_truncated || result.total_was_estimated) {
        throw new Error('既存レコードの衝突確認が完了できませんでした。');
      }
      if (payload.method === 'insert' && result.records.length) {
        throw new Error(`新規追加モードですが、同じ ${key} の投稿が既にあります。二重登録を防ぐため停止しました。`);
      }
      const seen = new Set();
      for (const row of result.records) {
        const expected = key === 'id' ? byId.get(String(row.id)) : bySlug.get(row.slug);
        if (!expected || String(row.id) !== String(expected.id) || row.slug !== expected.slug || row.source !== expected.source) {
          throw new Error(`既存投稿と ID / slug / source が衝突しています: id=${row.id}, slug=${row.slug}`);
        }
        if (seen.has(row.slug)) throw new Error(`送信先の slug が重複しています: ${row.slug}`);
        seen.add(row.slug);
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
    stdout.write('使い方: node data/_bodik_odcs/upload_to_odcs.js [--dry-run | --send] [--upload-images] [--upload-csv] [--csv-dir directory] [--insert-only] [--force] [--target komaruKurage | --target chushikokuSakana] [--output plan.json]\n省略時は両方を対象に、外部通信しない dry-run を実行します。--upload-images で画像、--upload-csv でCSVの生成・送信も対象にします。CSVはJSON投稿表を更新した後の全件から作成します。--insert-only は既存の id / slug があれば停止する新規追加専用モードです。--force は読み取り専用 DataStore への書き込みを明示的に許可します（元CSVの再取込で変更が失われる可能性があります）。Node.js 18.17+ が必要です。\n');
    return;
  }
  const config = loadConfig(env);
  if (args.csvDir) config.csvDir = path.resolve(args.csvDir);
  const plans = buildUploadPlans(args.targets, config, args);
  if (args.uploadCsv) for (const plan of plans) plan.csv = writeCsvPreview(plan, config.csvDir);
  stderr.write(`${args.send ? 'SEND' : 'DRY RUN（外部通信なし）'}: ${config.baseUrl} / 分類別の ${plans.length} データセット\n`);
  for (const plan of plans) {
    stderr.write(`${plan.target}: dataset_id=${plan.dataset_id || '未設定'} / resource_id=${plan.payload.resource_id || '未設定'} / method=${plan.payload.method}\n`);
    for (const summary of plan.summaries) stderr.write(`入力 ${summary.total} 件 / 採用 ${summary.included} 件 / 除外 ${summary.skipped} 件\n`);
    for (const item of plan.skipped) stderr.write(`除外: ${item.target}/${item.slug}: ${item.reason}\n`);
    if (plan.images) stderr.write(`画像: ${plan.images.length} 枚 / ${(plan.images.reduce((sum, image) => sum + image.size, 0) / 1024 / 1024).toFixed(2)} MiB\n`);
    if (plan.csv) stderr.write(`CSVプレビュー: ${plan.csv.preview_path}\n`);
  }
  const review = {
    type: 'repot-odcs-separated-upload-plan-v1',
    datasets: plans.map((plan) => ({
      target: plan.target, dataset_id: plan.dataset_id,
      ...(plan.images ? imageReviewPlan(plan.payload, plan.images) : { payload: plan.payload }),
      ...(plan.csv ? { csv: plan.csv } : {}),
    })),
  };
  const json = `${JSON.stringify(review, null, 2)}\n`;
  if (args.output) {
    // 既存ファイルや元アーカイブを誤って上書きしない。
    fs.writeFileSync(path.resolve(args.output), json, { flag: 'wx' });
    stderr.write(`確認用 JSON を保存しました: ${path.resolve(args.output)}\n`);
  }
  if (!args.send) {
    if (!args.output) stdout.write(json);
    return;
  }
  await validateDestinations(plans, config, fetchImpl);
  const request = (action, params, method = 'GET') => ckanRequest(action, params, config, fetchImpl, method);
  const csvPlans = [];
  if (args.uploadCsv) for (const plan of plans) csvPlans.push(await prepareCsvUpload(plan, config, request));
  const csvResults = [];
  for (const [index, plan] of plans.entries()) {
    await sendPayload(plan.payload, config, fetchImpl, {
      images: plan.images,
      onImage: ({ filename, action }) => stderr.write(`${plan.target} 画像 ${action}: ${filename}\n`),
    });
    stdout.write(`アップロード成功: ${plan.target} ${plan.payload.records.length} 件 / resource_id=${plan.payload.resource_id}\n`);
    if (args.uploadCsv) {
      const result = await uploadCsv(csvPlans[index], config, request, fetchImpl, config.csvDir);
      csvResults.push(result);
      writeCsvFile(path.join(config.csvDir, 'csv_upload_report.json'), Buffer.from(`${JSON.stringify(csvResults, null, 2)}\n`));
      stdout.write(`CSV ${result.action}: ${plan.target} ${result.records} 件 / ${result.url}\n`);
    }
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`実行失敗: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, loadConfig, readArchive, stableId, mapRecord, buildPayload, buildUploadPlans, validateDestinations, verifyUniqueId, ckanRequest, sendPayload, run };
