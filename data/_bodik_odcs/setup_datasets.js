#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadConfig, ckanRequest, verifyUniqueId } = require('./upload_to_odcs');
const { datasetMarker, tableMarker, datasetMetadata, tableMetadata } = require('./lib/metadata');

const REGISTRY_PATH = path.join(__dirname, 'config', 'datasets.json');
const NUMERIC_FIELDS = new Set(['id', 'user_id', 'timestamp', 'lat', 'lon']);
const FIELDS = ['id', 'user_id', 'slug', 'timestamp', 'lat', 'lon', 'location_alt', 'status',
  'caption', 'tags', 'species', 'filename', 'image_url', 'source', 'created_at', 'updated_at', 'deleted_at']
  .map((id) => ({ id, type: NUMERIC_FIELDS.has(id) ? 'numeric' : 'text' }));

function saveRegistry(registry, filename) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, filename);
}

function validateDataset(dataset, definition, target, registry) {
  if (dataset.name !== definition.name || dataset.owner_org !== registry.owner_org
      || !dataset.notes?.includes(datasetMarker(target)) || dataset.state === 'deleted') {
    throw new Error(`${definition.name}: 管理対象のデータセットと一致しません。既存データは変更しません。`);
  }
}

async function provision({ send = false, config = loadConfig(process.env), fetchImpl = globalThis.fetch,
  registryPath = REGISTRY_PATH, stdout = process.stdout } = {}) {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (!registry.owner_org || !registry.license_id || Object.keys(registry.targets).length !== 2) {
    throw new Error('config/datasets.json の組織・ライセンス・送信先2件を確認してください。');
  }
  if (!send) {
    stdout.write(`${JSON.stringify({ owner_org: registry.owner_org, license_id: registry.license_id,
      datasets: registry.targets, fields: FIELDS, primary_key: ['id'] }, null, 2)}\n`);
    return registry;
  }
  if (!config.apiKey.trim()) throw new Error('CKAN_API_KEY が未設定です。');
  const request = (action, params, method = 'GET') => ckanRequest(action, params, config, fetchImpl, method);
  const source = await request('package_show', { id: registry.source_dataset_id });
  if (source.owner_org !== registry.owner_org || source.license_id !== registry.license_id) {
    throw new Error('元データセットの組織またはライセンスが設定と一致しません。');
  }

  const existing = new Map();
  // 両方の名前衝突を確認してから作成を始める。
  for (const [target, definition] of Object.entries(registry.targets)) {
    let dataset;
    try {
      dataset = await request('package_show', { id: definition.dataset_id || definition.name });
    } catch (error) {
      if (error.status !== 404 || definition.dataset_id) throw error;
    }
    if (dataset) validateDataset(dataset, definition, target, registry);
    existing.set(target, dataset);
  }

  for (const [target, definition] of Object.entries(registry.targets)) {
    let dataset = existing.get(target);
    if (!dataset) {
      dataset = await request('package_create', {
        name: definition.name,
        title: definition.title,
        owner_org: registry.owner_org,
        license_id: registry.license_id,
        private: false,
        ...datasetMetadata(target, definition),
      }, 'POST');
      validateDataset(dataset, definition, target, registry);
      definition.dataset_id = dataset.id;
      saveRegistry(registry, registryPath);
      stdout.write(`データセット作成: ${definition.title} / ${dataset.id}\n`);
    }
    definition.dataset_id = dataset.id;
    dataset = await request('package_show', { id: dataset.id });
    const presentation = tableMetadata(target, definition);
    const candidates = (dataset.resources || []).filter((resource) => resource.id === definition.resource_id
      || resource.name === presentation.name || resource.name === `${target}.json`);
    if (candidates.length > 1) throw new Error(`${target}: 表データのリソースが重複しています。`);
    let table = candidates[0];
    if (table && (!table.description?.includes(tableMarker(target)) || table.package_id !== dataset.id
        || (definition.resource_id && table.id !== definition.resource_id))) {
      throw new Error(`${target}: 同名の管理対象外リソースがあります。`);
    }
    if (!table) {
      if (definition.resource_id) throw new Error(`${target}: 保存済みの表データが見つかりません。`);
      const created = await request('datastore_create', {
        resource: { package_id: dataset.id, ...presentation, format: 'JSON', url_type: 'datastore' },
        fields: FIELDS,
        primary_key: ['id'],
        records: [],
      }, 'POST');
      if (!created.resource_id) throw new Error(`${target}: 作成された表データの ID が取得できません。`);
      definition.resource_id = created.resource_id;
      saveRegistry(registry, registryPath);
      table = await request('resource_show', { id: created.resource_id });
      stdout.write(`投稿表作成: ${target} / ${table.id}\n`);
    }
    if (table.package_id !== dataset.id || table.url_type !== 'datastore') throw new Error(`${target}: 作成先または投稿表の種類が一致しません。`);
    const info = await request('datastore_info', { resource_id: table.id });
    const fields = new Map((info.fields || []).map((field) => [field.id, field]));
    if (FIELDS.some((field) => fields.get(field.id)?.type !== field.type)) throw new Error(`${target}: 投稿表の列が一致しません。`);
    await verifyUniqueId(info.fields, table.id, config, fetchImpl);
    definition.resource_id = table.id;
    saveRegistry(registry, registryPath);
    stdout.write(`送信先確認: ${config.baseUrl}/dataset/${definition.name}\n`);
  }
  if (new Set(Object.values(registry.targets).map((target) => target.dataset_id)).size !== 2) {
    throw new Error('2分類のデータセットが同じです。');
  }
  return registry;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.some((value) => !['--send', '--dry-run'].includes(value)) || (argv.includes('--send') && argv.includes('--dry-run'))) {
    console.error('使い方: node setup_datasets.js [--dry-run | --send]');
    process.exitCode = 1;
  } else {
    provision({ send: argv.includes('--send') }).catch((error) => {
      const secret = process.env.CKAN_API_KEY;
      console.error(secret ? error.message.split(secret).join('[redacted]') : error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { provision, FIELDS, datasetMarker, tableMarker };
