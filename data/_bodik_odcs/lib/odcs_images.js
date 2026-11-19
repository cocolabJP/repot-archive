'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { imageMetadata, legacyImageName, readImageMetadata } = require('./metadata');

const IMAGE_TYPES = {
  '.png': { mimetype: 'image/png', format: 'PNG' },
  '.jpg': { mimetype: 'image/jpeg', format: 'JPEG' },
  '.jpeg': { mimetype: 'image/jpeg', format: 'JPEG' },
  '.gif': { mimetype: 'image/gif', format: 'GIF' },
  '.webp': { mimetype: 'image/webp', format: 'WEBP' },
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkImage(bytes, format, filename) {
  const valid = {
    PNG: () => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    JPEG: () => bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')),
    GIF: () => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')),
    WEBP: () => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  }[format];
  if (!valid?.()) throw new Error(`${filename}: 画像の形式と拡張子が一致しません。`);
}

function buildImagePlan(payload, imageDir, definition = {}) {
  const files = new Map();
  for (const record of payload.records) {
    const filename = record.filename;
    if (!filename || path.basename(filename) !== filename || /[\\/]/.test(filename)) throw new Error('画像ファイル名が不正です。');
    if (files.has(filename)) continue;
    const type = IMAGE_TYPES[path.extname(filename).toLowerCase()];
    if (!type) throw new Error(`${filename}: 未対応の画像形式です。`);
    const localPath = path.resolve(imageDir, filename);
    if (!fs.statSync(localPath).isFile()) throw new Error(`${localPath}: 画像ファイルではありません。`);
    const bytes = fs.readFileSync(localPath);
    checkImage(bytes, type.format, filename);
    const digest = sha256(bytes);
    files.set(filename, {
      filename,
      local_path: localPath,
      size: bytes.length,
      sha256: digest,
      ...type,
      legacy_name: legacyImageName(filename),
      ...imageMetadata({ filename, sha256: digest }, definition),
    });
  }
  return [...files.values()];
}

function imageUrl(resource, baseUrl) {
  if (typeof resource?.url !== 'string' || !resource.url.trim()) throw new Error('画像リソースの URL がありません。');
  const url = new URL(resource.url, `${baseUrl}/`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('画像リソースの URL が不正です。');
  return url.href;
}

function checkResource(resource, image, packageId, tableId, baseUrl) {
  if (!resource || typeof resource.id !== 'string' || !resource.id || resource.id === tableId
      || resource.package_id !== packageId || resource.url_type !== 'upload'
      || ![image.name, image.legacy_name].includes(resource.name) || (resource.state && resource.state !== 'active')) {
    throw new Error(`${image.filename}: 既存の画像リソースを安全に識別できません。`);
  }
  let metadata;
  try {
    metadata = readImageMetadata(resource.description);
  } catch {
    throw new Error(`${image.filename}: 同名の管理対象外リソースがあります。`);
  }
  if (metadata?.filename !== image.filename || !/^[0-9a-f]{64}$/.test(metadata?.sha256)) {
    throw new Error(`${image.filename}: 画像リソースの管理情報が一致しません。`);
  }
  return { hash: metadata.sha256, url: imageUrl(resource, baseUrl) };
}

// 全画像の衝突確認を、最初のファイル書き込みより前に終える。
async function prepareImageUploads(images, payload, config, request) {
  const table = await request('resource_show', { id: payload.resource_id });
  if (!table?.package_id || !table.id) throw new Error('表データの所属データセットを取得できません。');
  const dataset = await request('package_show', { id: table.package_id });
  if (dataset?.id !== table.package_id || !Array.isArray(dataset.resources)
      || !dataset.resources.some((resource) => resource.id === table.id)) {
    throw new Error('画像の保存先データセットを確認できません。');
  }
  return images.map((image) => {
    const matches = dataset.resources.filter((resource) => [image.name, image.legacy_name].includes(resource.name));
    if (matches.length > 1) throw new Error(`${image.filename}: 同名の画像リソースが重複しています。`);
    const existing = matches[0];
    let action = 'create';
    let url = '';
    if (existing) {
      const info = checkResource(existing, image, dataset.id, table.id, config.baseUrl);
      url = info.url;
      action = info.hash === image.sha256 ? 'reuse' : 'update';
    }
    return { image, action, existing, url, packageId: dataset.id, tableId: table.id };
  });
}

async function uploadImages(tasks, config, request, onImage = () => {}) {
  const results = new Map();
  for (const task of tasks) {
    const { image, action, packageId, tableId } = task;
    // 計画を生成した後にファイルが変わっていた場合は、古いハッシュで送らない。
    const bytes = fs.readFileSync(image.local_path);
    if (sha256(bytes) !== image.sha256) throw new Error(`${image.filename}: 検証後に画像が変更されました。再実行してください。`);
    let resource = task.existing;
    let url = task.url;
    if (action !== 'reuse') {
      const form = new FormData();
      if (action === 'create') form.set('package_id', packageId);
      else form.set('id', resource.id);
      for (const key of ['name', 'description', 'format', 'mimetype']) form.set(key, image[key]);
      form.set('hash', image.sha256);
      form.set('upload', new Blob([bytes], { type: image.mimetype }), image.filename);
      resource = await request(action === 'create' ? 'resource_create' : 'resource_patch', form, 'POST');
      const info = checkResource(resource, image, packageId, tableId, config.baseUrl);
      if (info.hash !== image.sha256 || (action === 'update' && resource.id !== task.existing.id)) {
        throw new Error(`${image.filename}: 画像アップロードの応答が一致しません。`);
      }
      url = info.url;
    }
    results.set(image.filename, { id: resource.id, url });
    onImage({ filename: image.filename, action, id: resource.id });
  }
  return results;
}

function attachImageUrls(payload, uploads) {
  return {
    ...payload,
    records: payload.records.map((record) => {
      const image = uploads.get(record.filename);
      if (!image?.url) throw new Error(`${record.filename}: アップロード後の URL がありません。`);
      return { ...record, image_url: image.url };
    }),
  };
}

function imageReviewPlan(payload, images) {
  return {
    type: 'repot-odcs-image-upload-plan-v1',
    note: '画像の保存先データセットは resource_show で特定します。image_url はアップロード後に確定するため、この計画では null です。この JSON を datastore_upsert に直接送らないでください。',
    images,
    payload: { ...payload, records: payload.records.map((record) => ({ ...record, image_url: null })) },
  };
}

module.exports = { buildImagePlan, prepareImageUploads, uploadImages, attachImageUrls, imageReviewPlan };
