'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { datasetMarker, csvMetadata, readCsvMetadata, normalizeMetadataText } = require('./metadata');
const { RECORD_FIELDS, assertRecordFields, imageFilename } = require('./odcs_schema');

const CSV_FIELDS = RECORD_FIELDS;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function csvCell(value) {
  if (value == null) return '';
  if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error('CSVに出力できない値があります。');
  }
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function serializeCsv(records) {
  const lines = [CSV_FIELDS.join(',')];
  for (const record of records) {
    assertRecordFields(record);
    lines.push(CSV_FIELDS.map((field) => csvCell(record[field])).join(','));
  }
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

function writeCsvFile(filename, bytes) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeCsvPreview(plan, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${plan.target}.preview.csv`);
  const records = plan.images ? plan.payload.records.map((record) => ({ ...record, image_url: null })) : plan.payload.records;
  writeCsvFile(filename, serializeCsv(records));
  return { filename: `${plan.target}.csv`, preview_path: filename,
    note: '送信予定のレコードです。送信時はJSON投稿表の更新後に全件を読み直して確定CSVを生成します。画像送信を伴う場合、プレビューの画像URLは空欄です。' };
}

async function prepareCsvUpload(plan, config, request) {
  const dataset = await request('package_show', { id: plan.dataset_id });
  if (dataset?.id !== plan.dataset_id || !dataset.notes?.includes(datasetMarker(plan.target))
      || !dataset.resources?.some((resource) => resource.id === plan.payload.resource_id && resource.package_id === dataset.id)) {
    throw new Error(`${plan.target}: CSVの保存先を確認できません。`);
  }
  const definition = config.definitions[plan.target];
  const name = csvMetadata(plan.target, definition, { table_resource_id: plan.payload.resource_id, sha256: '0'.repeat(64) }).name;
  const matches = dataset.resources.filter((resource) => {
    const metadata = readCsvMetadata(resource.description);
    return resource.name === name || (metadata?.target === plan.target && metadata.table_resource_id === plan.payload.resource_id);
  });
  if (matches.length > 1) throw new Error(`${plan.target}: CSVリソースが重複しています。`);
  const existing = matches[0];
  if (existing) {
    const metadata = readCsvMetadata(existing.description);
    if (existing.package_id !== dataset.id || existing.url_type !== 'upload' || existing.format?.toUpperCase() !== 'CSV'
        || metadata?.target !== plan.target || metadata.table_resource_id !== plan.payload.resource_id) {
      throw new Error(`${plan.target}: 同名の管理対象外CSVがあります。`);
    }
  }
  return { plan, definition, existing };
}

async function readCsvRecords(resourceId, request) {
  const records = [];
  const ids = new Set();
  let total;
  while (total === undefined || records.length < total) {
    const page = await request('datastore_search', { resource_id: resourceId, fields: CSV_FIELDS.join(','),
      limit: 1000, offset: records.length, sort: 'id asc', include_total: true });
    if (!Number.isSafeInteger(page?.total) || !Array.isArray(page.records) || page.records_truncated || page.total_was_estimated
        || (total !== undefined && page.total !== total) || (!page.records.length && records.length < page.total)) {
      throw new Error('CSV用の投稿データを全件取得できません。');
    }
    total = page.total;
    for (const record of page.records) {
      if (CSV_FIELDS.some((field) => !Object.hasOwn(record, field))) throw new Error('投稿表にCSVの必要項目がありません。');
      if (ids.has(String(record.id))) throw new Error('CSV用データの取得中にIDが重複しました。');
      ids.add(String(record.id));
      records.push(Object.fromEntries(CSV_FIELDS.map((field) => [field, record[field]])));
    }
    if (records.length > total) throw new Error('CSV用データの件数が一致しません。');
  }
  return records;
}

async function uploadCsv(prepared, config, request, fetchImpl, directory) {
  const { plan, definition, existing } = prepared;
  const records = await readCsvRecords(plan.payload.resource_id, request);
  const expected = new Map(plan.payload.records.map((record) => [String(record.id), record]));
  for (const record of records) {
    const sent = expected.get(String(record.id));
    if (sent && Number(record.timestamp) === sent.timestamp && imageFilename(record.image_url) === imageFilename(sent.image_url)) {
      expected.delete(String(record.id));
    }
  }
  if (expected.size) throw new Error('送信した投稿がCSVの元データに見つかりません。');
  const bytes = serializeCsv(records);
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${plan.target}.csv`;
  const localPath = path.join(directory, filename);
  writeCsvFile(localPath, bytes);
  const sha256 = digest(bytes);
  const presentation = csvMetadata(plan.target, definition, { table_resource_id: plan.payload.resource_id, sha256 });
  let resource = existing;
  let action = 'reuse';
  if (!existing || readCsvMetadata(existing.description).sha256 !== sha256) {
    action = existing ? 'update' : 'create';
    const form = new FormData();
    if (existing) form.set('id', existing.id);
    else form.set('package_id', plan.dataset_id);
    for (const [key, value] of Object.entries(presentation)) form.set(key, value);
    form.set('format', 'CSV');
    form.set('mimetype', 'text/csv');
    form.set('hash', sha256);
    form.set('upload', new Blob([bytes], { type: 'text/csv' }), filename);
    resource = await request(existing ? 'resource_patch' : 'resource_create', form, 'POST');
  } else if (existing.name !== presentation.name || normalizeMetadataText(existing.description) !== normalizeMetadataText(presentation.description)) {
    action = 'metadata';
    resource = await request('resource_patch', { id: existing.id, ...presentation }, 'POST');
  }
  const metadata = readCsvMetadata(resource?.description);
  if (!resource?.id || resource.package_id !== plan.dataset_id || resource.url_type !== 'upload' || resource.format?.toUpperCase() !== 'CSV'
      || (existing && resource.id !== existing.id) || metadata?.sha256 !== sha256 || metadata?.target !== plan.target
      || metadata?.table_resource_id !== plan.payload.resource_id || resource.name !== presentation.name) {
    throw new Error(`${plan.target}: CSVアップロードの応答が一致しません。`);
  }
  const url = new URL(resource.url, `${config.baseUrl}/`);
  if (url.origin !== new URL(config.baseUrl).origin || url.username || url.password) throw new Error('CSVの取得先URLが想定と異なります。');
  const response = await fetchImpl(url.href, { headers: { Authorization: config.apiKey }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || digest(Buffer.from(await response.arrayBuffer())) !== sha256) throw new Error('アップロード後のCSVが生成ファイルと一致しません。');
  return { target: plan.target, action, resource_id: resource.id, url: url.href, local_path: localPath, records: records.length,
    fields: CSV_FIELDS.length, sha256, verified: true };
}

module.exports = { CSV_FIELDS, serializeCsv, writeCsvFile, writeCsvPreview, prepareCsvUpload, readCsvRecords, uploadCsv };
