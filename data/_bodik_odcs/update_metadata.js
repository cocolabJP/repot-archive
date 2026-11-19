#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadConfig, buildUploadPlans, ckanRequest } = require('./upload_to_odcs');
const { datasetMarker, tableMarker, datasetMetadata, tableMetadata, readImageMetadata, csvMetadata, readCsvMetadata, normalizeMetadataText } = require('./metadata');

function buildMetadataPlans(config) {
  return buildUploadPlans(['komaruKurage', 'chushikokuSakana'], config, { uploadImages: true }).map((plan) => ({
    target: plan.target,
    dataset: { id: plan.dataset_id, ...datasetMetadata(plan.target, config.definitions[plan.target]) },
    table: { id: plan.payload.resource_id, ...tableMetadata(plan.target, config.definitions[plan.target]) },
    csv: { resource_name: config.definitions[plan.target].resource_name, source_url: config.definitions[plan.target].source_url },
    images: plan.images,
  }));
}

function mergeExtras(existing, desired) {
  const merged = new Map((existing || []).map((entry) => [entry.key, entry.value]));
  for (const entry of desired) if (entry.value !== '' || !merged.has(entry.key)) merged.set(entry.key, entry.value);
  return [...merged].map(([key, value]) => ({ key, value }));
}

function sameField(key, current, desired) {
  if (['notes', 'description'].includes(key) && typeof current === 'string' && typeof desired === 'string') {
    return normalizeMetadataText(current) === normalizeMetadataText(desired);
  }
  if (key === 'tags') return JSON.stringify((current || []).map((tag) => tag.name).sort()) === JSON.stringify(desired.map((tag) => tag.name).sort());
  if (key === 'extras') {
    const sort = (entries) => [...entries].sort((a, b) => a.key.localeCompare(b.key));
    return JSON.stringify(sort(current || [])) === JSON.stringify(sort(desired));
  }
  return current === desired;
}

async function prepareUpdates(plans, ownerOrg, request) {
  const updates = [];
  const snapshots = [];
  const add = (action, current, desired, target) => {
    if (!Object.entries(desired).some(([key, value]) => key !== 'id' && !sameField(key, current[key], value))) return;
    const before = Object.fromEntries(Object.keys(desired).map((key) => [key, current[key] ?? null]));
    updates.push({ action, target, params: desired, before,
      resource_url: action === 'resource_patch' ? current.url : undefined,
      package_id: action === 'resource_patch' ? current.package_id : undefined });
  };
  for (const plan of plans) {
    if (!plan.dataset.id || !plan.table.id) throw new Error('データセットと投稿表の設定が必要です。');
    const dataset = await request('package_show', { id: plan.dataset.id });
    if (dataset.id !== plan.dataset.id || dataset.owner_org !== ownerOrg || !dataset.notes?.includes(datasetMarker(plan.target))) {
      throw new Error(`${plan.target}: 管理対象データセットと一致しません。`);
    }
    const table = dataset.resources.find((resource) => resource.id === plan.table.id);
    if (!table || table.package_id !== dataset.id || !table.description?.includes(tableMarker(plan.target))) {
      throw new Error(`${plan.target}: 投稿表と一致しません。`);
    }
    const rows = await request('datastore_search', { resource_id: table.id, limit: 10000, sort: '_id asc' });
    if (rows.total !== rows.records?.length) throw new Error('投稿表の内容を全件確認できません。');
    snapshots.push({ target: plan.target, resource_id: table.id, total: rows.total, records: rows.records });
    add('package_patch', dataset, { ...plan.dataset, extras: mergeExtras(dataset.extras, plan.dataset.extras) }, plan.target);
    add('resource_patch', table, plan.table, plan.target);
    const csvResources = dataset.resources.filter((resource) => {
      const metadata = readCsvMetadata(resource.description);
      return metadata?.target === plan.target && metadata.table_resource_id === table.id;
    });
    if (csvResources.length > 1) throw new Error(`${plan.target}: CSVリソースが重複しています。`);
    if (csvResources.length) {
      const resource = csvResources[0];
      if (resource.package_id !== dataset.id || resource.url_type !== 'upload' || resource.format?.toUpperCase() !== 'CSV') throw new Error('CSVの所属または形式が一致しません。');
      const metadata = readCsvMetadata(resource.description);
      add('resource_patch', resource, { id: resource.id, ...csvMetadata(plan.target, plan.csv, metadata) }, plan.target);
    }
    for (const image of plan.images) {
      const matches = dataset.resources.filter((resource) => [image.name, image.legacy_name].includes(resource.name));
      if (matches.length !== 1 || matches[0].package_id !== dataset.id) throw new Error(`${image.filename}: 画像の所属を確認できません。`);
      const current = matches[0];
      const metadata = readImageMetadata(current.description);
      if (metadata.filename !== image.filename || metadata.sha256 !== image.sha256) throw new Error(`${image.filename}: 画像の管理情報が一致しません。`);
      add('resource_patch', current, { id: current.id, name: image.name, description: image.description }, plan.target);
    }
  }
  return { updates, snapshots };
}

async function updateMetadata({ send = false, config = loadConfig(process.env), fetchImpl = globalThis.fetch,
  backupPath, reportPath = path.join(__dirname, 'metadata_update_report.json'), stdout = process.stdout, outputPath } = {}) {
  const plans = buildMetadataPlans(config);
  if (!send) {
    const json = `${JSON.stringify({ datasets: plans }, null, 2)}\n`;
    if (outputPath) fs.writeFileSync(outputPath, json, { flag: 'wx' });
    else stdout.write(json);
    return plans;
  }
  if (!config.apiKey.trim()) throw new Error('CKAN_API_KEY が未設定です。');
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets.json'), 'utf8'));
  const request = (action, params, method = 'GET') => ckanRequest(action, params, config, fetchImpl, method);
  const { updates, snapshots } = await prepareUpdates(plans, registry.owner_org, request);
  const backup = backupPath || path.join(__dirname, `metadata_backup_${randomUUID()}.json`);
  if (updates.length) fs.writeFileSync(backup, `${JSON.stringify({ updates, snapshots }, null, 2)}\n`, { flag: 'wx' });
  const report = { backup: updates.length ? backup : null, completed: [], verified: [] };
  try {
    for (const update of updates) {
      const result = await request(update.action, update.params, 'POST');
      if (Object.entries(update.params).some(([key, value]) => !sameField(key, result[key], value))) {
        throw new Error(`${update.params.id}: メタデータの更新結果が一致しません。`);
      }
      if (update.action === 'resource_patch' && (result.url !== update.resource_url || result.package_id !== update.package_id)) {
        throw new Error('画像URLまたは所属先が変更されています。');
      }
      report.completed.push({ target: update.target, action: update.action, id: update.params.id });
      stdout.write(`説明更新: ${update.target} / ${update.params.title || update.params.name}\n`);
    }
    for (const snapshot of snapshots) {
      const after = await request('datastore_search', { resource_id: snapshot.resource_id, limit: 10000, sort: '_id asc' });
      if (after.total !== snapshot.total || JSON.stringify(after.records) !== JSON.stringify(snapshot.records)) {
        throw new Error(`${snapshot.target}: 投稿表の内容が更新前と一致しません。`);
      }
      report.verified.push({ target: snapshot.target, resource_id: snapshot.resource_id, records: after.total, dataUnchanged: true });
    }
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    stdout.write(`メタデータ更新完了: ${updates.length} 件。投稿表の内容と画像URLを確認しました。\n`);
    return report;
  } catch (error) {
    report.error = config.apiKey ? error.message.split(config.apiKey).join('[redacted]') : error.message;
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const options = {};
  try {
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--send') options.send = true;
      else if (argv[i] === '--dry-run') options.dryRun = true;
      else if (['--output', '--backup'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        const key = argv[i] === '--output' ? 'outputPath' : 'backupPath';
        options[key] = path.resolve(argv[++i]);
      } else throw new Error('使い方: node update_metadata.js [--dry-run | --send] [--output plan.json] [--backup backup.json]');
    }
    if (options.send && options.dryRun) throw new Error('--send と --dry-run は同時に指定できません。');
    updateMetadata(options).catch((error) => {
      const secret = process.env.CKAN_API_KEY;
      console.error(secret ? error.message.split(secret).join('[redacted]') : error.message);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildMetadataPlans, prepareUpdates, mergeExtras, updateMetadata };
