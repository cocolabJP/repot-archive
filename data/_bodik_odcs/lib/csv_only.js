'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { serializeCsv, writeCsvFile, CSV_FIELDS } = require('./odcs_csv');
const { datasetMarker, tableMarker, datasetMetadata, csvMetadata, readCsvMetadata, readImageMetadata, normalizeMetadataText } = require('./metadata');
const { imageFilename } = require('./odcs_schema');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fingerprint = (resource) => JSON.stringify(['id', 'package_id', 'name', 'description', 'url', 'url_type', 'format', 'last_modified']
  .map((key) => resource[key] ?? null));

function generateCsvPlans(plans, directory) {
  fs.mkdirSync(directory, { recursive: true });
  return plans.map((plan) => {
    const bytes = serializeCsv(plan.payload.records);
    const filename = `${plan.target}.csv`;
    const localPath = path.join(directory, filename);
    writeCsvFile(localPath, bytes);
    return { ...plan, bytes, sha256: digest(bytes), filename, local_path: localPath };
  });
}

function resourceUrl(resource, config) {
  const url = new URL(resource.url, `${config.baseUrl}/`);
  if (url.origin !== new URL(config.baseUrl).origin || url.username || url.password) throw new Error('リソースの取得先がBODIKと一致しません。');
  return url.href;
}

async function download(resource, config, fetchImpl) {
  const response = await fetchImpl(resourceUrl(resource, config), {
    headers: { Authorization: config.apiKey }, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`リソースを取得できません: ${resource.id} / HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function prepareCsvOnly(plans, config, request, { replaceLegacy = false } = {}) {
  const prepared = [];
  const datasets = new Set();
  for (const plan of plans) {
    if (!plan.dataset_id || datasets.has(plan.dataset_id)) throw new Error('魚とクラゲには別々のデータセットを指定してください。');
    datasets.add(plan.dataset_id);
    const definition = config.definitions[plan.target];
    const dataset = await request('package_show', { id: plan.dataset_id });
    if (dataset?.id !== plan.dataset_id || dataset.owner_org !== config.ownerOrg || dataset.name !== definition.name
        || !dataset.notes?.includes(datasetMarker(plan.target)) || dataset.state === 'deleted' || !Array.isArray(dataset.resources)) {
      throw new Error(`${plan.target}: 管理対象データセットと一致しません。`);
    }
    const presentation = csvMetadata(plan.target, definition, { sha256: plan.sha256 });
    const matches = dataset.resources.filter((resource) => resource.id === definition.csv_resource_id
      || resource.name === presentation.name || readCsvMetadata(resource.description)?.target === plan.target);
    if (matches.length > 1) throw new Error(`${plan.target}: CSVリソースが重複しています。`);
    const existing = matches[0];
    if ((!existing && definition.csv_resource_id) || (existing && (existing.package_id !== dataset.id || existing.url_type !== 'upload'
        || existing.format?.toUpperCase() !== 'CSV' || readCsvMetadata(existing.description)?.target !== plan.target
        || (definition.csv_resource_id && existing.id !== definition.csv_resource_id)))) {
      throw new Error(`${plan.target}: 同名の管理対象外CSVまたは送信先IDの不一致があります。`);
    }
    const legacy = [];
    if (replaceLegacy) {
      for (const resource of dataset.resources) {
        if (resource.id === existing?.id) continue;
        if (resource.description?.includes(tableMarker(plan.target))) {
          const tableId = definition.legacy_table_resource_id || definition.resource_id;
          if (resource.id !== tableId || resource.package_id !== dataset.id || resource.format?.toUpperCase() !== 'JSON'
              || resource.url_type !== 'datastore') throw new Error('削除対象のJSON表を安全に識別できません。');
          legacy.push({ type: 'json', resource });
        } else if (/repot-image-v1:/.test(resource.description || '')) {
          const metadata = readImageMetadata(resource.description);
          if (resource.package_id !== dataset.id || resource.url_type !== 'upload'
              || !plan.payload.records.some((record) => imageFilename(record.image_url) === metadata.filename)) {
            throw new Error('削除対象の画像をCSVの投稿と対応付けられません。');
          }
          legacy.push({ type: 'image', resource, metadata });
        }
      }
    }
    prepared.push({ plan, definition, dataset, existing, presentation, legacy });
  }
  return prepared;
}

async function readLegacyRows(item, request) {
  const rows = await request('datastore_search', { resource_id: item.resource.id, limit: 10000, sort: '_id asc' });
  if (!Array.isArray(rows?.records) || rows.total !== rows.records.length || rows.records_truncated || rows.total_was_estimated) {
    throw new Error('削除前のJSONを全件取得できません。');
  }
  return rows;
}

async function backupCsvOnly(prepared, config, request, fetchImpl, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const backupPath = path.join(directory, `csv_only_${randomUUID()}`);
  fs.mkdirSync(backupPath);
  const snapshots = [];
  for (const entry of prepared) {
    const snapshot = { dataset: entry.dataset, tables: [], files: [] };
    const resources = [...(entry.existing ? [{ type: 'csv', resource: entry.existing }] : []), ...entry.legacy];
    for (const item of resources) {
      if (item.type === 'json') {
        const rows = await readLegacyRows(item, request);
        const byId = new Map(entry.plan.payload.records.map((record) => [String(record.id), record]));
        for (const row of rows.records) {
          const expected = byId.get(String(row.id));
          if (!expected || Number(row.timestamp) !== expected.timestamp || imageFilename(row.image_url) !== imageFilename(expected.image_url)) {
            throw new Error('CSVに含まれない投稿が既存JSONにあります。削除しません。');
          }
        }
        item.snapshot = rows;
        snapshot.tables.push({ resource_id: item.resource.id, ...rows });
      } else {
        const bytes = await download(item.resource, config, fetchImpl);
        const sha256 = digest(bytes);
        if (item.type === 'image' && sha256 !== item.metadata.sha256) throw new Error('削除前の画像と管理情報のハッシュが一致しません。');
        const filename = `${item.resource.id}.${item.type === 'csv' ? 'csv' : 'image'}`;
        fs.writeFileSync(path.join(backupPath, filename), bytes, { flag: 'wx' });
        snapshot.files.push({ resource_id: item.resource.id, filename, sha256 });
      }
    }
    snapshots.push(snapshot);
  }
  fs.writeFileSync(path.join(backupPath, 'before.json'), `${JSON.stringify(snapshots, null, 2)}\n`, { flag: 'wx' });
  return backupPath;
}

async function verifyCsvResource(resource, entry, config, fetchImpl) {
  const metadata = readCsvMetadata(resource?.description);
  if (!resource?.id || resource.package_id !== entry.dataset.id || resource.url_type !== 'upload'
      || resource.format?.toUpperCase() !== 'CSV' || (entry.existing && resource.id !== entry.existing.id)
      || metadata?.target !== entry.plan.target || metadata.sha256 !== entry.plan.sha256 || metadata.table_resource_id
      || resource.name !== entry.presentation.name) throw new Error('CSVアップロードの応答が一致しません。');
  const bytes = await download(resource, config, fetchImpl);
  if (digest(bytes) !== entry.plan.sha256) throw new Error('アップロード後のCSVが生成ファイルと一致しません。');
  return resourceUrl(resource, config);
}

async function publishCsvOnly(prepared, config, request, fetchImpl, { backupPath, onProgress = () => {} } = {}) {
  if (!backupPath || !fs.existsSync(path.join(backupPath, 'before.json'))) throw new Error('送信前のバックアップが必要です。');
  const report = { backup: backupPath, csv: [], deleted: [], datasets: [] };
  const save = () => {
    writeCsvFile(path.join(backupPath, 'result.json'), Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
    onProgress(report);
  };
  // 両方のCSVのアップロード・取得検証を終えてから削除する。
  for (const entry of prepared) {
    const { plan, existing, presentation, dataset } = entry;
    if (existing && fingerprint(await request('resource_show', { id: existing.id })) !== fingerprint(existing)) {
      throw new Error('確認後にCSVリソースが変更されました。再実行してください。');
    }
    let resource = existing;
    let action = 'reuse';
    if (!existing || readCsvMetadata(existing.description).sha256 !== plan.sha256) {
      action = existing ? 'update' : 'create';
      const form = new FormData();
      form.set(existing ? 'id' : 'package_id', existing ? existing.id : dataset.id);
      for (const [key, value] of Object.entries(presentation)) form.set(key, value);
      form.set('format', 'CSV'); form.set('mimetype', 'text/csv'); form.set('hash', plan.sha256);
      form.set('upload', new Blob([plan.bytes], { type: 'text/csv' }), plan.filename);
      resource = await request(existing ? 'resource_patch' : 'resource_create', form, 'POST');
    } else if (normalizeMetadataText(existing.description) !== normalizeMetadataText(presentation.description) || existing.name !== presentation.name) {
      action = 'metadata';
      resource = await request('resource_patch', { id: existing.id, ...presentation }, 'POST');
    }
    const url = await verifyCsvResource(resource, entry, config, fetchImpl);
    report.csv.push({ target: plan.target, action, resource_id: resource.id, url, records: plan.payload.records.length,
      fields: CSV_FIELDS.length, sha256: plan.sha256, verified: true });
    save();
  }
  for (const entry of prepared) {
    const desired = datasetMetadata(entry.plan.target, entry.definition);
    // 任意の追加情報は保持し、公開用の説明・出典・タグを更新する。
    delete desired.extras;
    const unchanged = Object.entries(desired).every(([key, value]) => {
      if (key === 'tags') return JSON.stringify((entry.dataset.tags || []).map((tag) => tag.name).sort()) === JSON.stringify(value.map((tag) => tag.name).sort());
      return entry.dataset[key] === value;
    });
    if (!unchanged) await request('package_patch', { id: entry.dataset.id, ...desired }, 'POST');
    for (const item of entry.legacy) {
      const current = await request('resource_show', { id: item.resource.id });
      if (fingerprint(current) !== fingerprint(item.resource)) throw new Error('確認後に削除対象が変更されました。停止します。');
      if (item.type === 'json') {
        const rows = await readLegacyRows(item, request);
        if (JSON.stringify(rows.records) !== JSON.stringify(item.snapshot.records)) throw new Error('バックアップ後にJSONの投稿が変更されました。削除しません。');
      }
      await request('resource_delete', { id: item.resource.id }, 'POST');
      report.deleted.push({ target: entry.plan.target, type: item.type, resource_id: item.resource.id });
      save();
    }
    const after = await request('package_show', { id: entry.dataset.id });
    const deletedIds = new Set(entry.legacy.map((item) => item.resource.id));
    if (after.resources.some((resource) => deletedIds.has(resource.id))) throw new Error('削除対象がデータセットに残っています。');
    const csv = report.csv.find((item) => item.target === entry.plan.target);
    const resource = after.resources.find((item) => item.id === csv.resource_id);
    await verifyCsvResource(resource, entry, config, fetchImpl);
    report.datasets.push({ target: entry.plan.target, id: after.id, resources: after.resources.map((item) => ({ id: item.id, format: item.format })), verified: true });
    save();
  }
  return report;
}

module.exports = { generateCsvPlans, prepareCsvOnly, backupCsvOnly, publishCsvOnly, download, digest };
