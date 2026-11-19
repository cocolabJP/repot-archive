'use strict';

const IMAGE_MARKER = 'repot-image-v1:';
const CSV_MARKER = 'repot-csv-v1:';
const datasetMarker = (target) => `repot-managed-dataset-v1:${target}`;
const tableMarker = (target) => `repot-managed-table-v1:${target}`;
const imageName = (filename) => `投稿写真_${filename}`;
const legacyImageName = (filename) => `repot-image:${filename}`;
const normalizeMetadataText = (text) => text.replace(/\r\n?/g, '\n');

function managedDescription(description, marker) {
  return `${description.trim()}\n\n<!-- ${marker} -->`;
}

function datasetMetadata(target, definition) {
  return {
    title: definition.title,
    notes: managedDescription(definition.description || `【試行中】\nレポっとの投稿記録と写真を公開しています。`, datasetMarker(target)),
    url: definition.source_url || 'https://repot-archive.cocolab.jp/',
    tags: (definition.tags || ['レポっと', target === 'komaruKurage' ? 'クラゲ' : '中四国魚']).map((name) => ({ name })),
    extras: [
      { key: 'copyright', value: '© repot contributors (modified)' },
      { key: 'frequency', value: '' },
      { key: 'language', value: 'Japanese' },
      { key: 'spatial', value: '' },
    ],
  };
}

function tableMetadata(target, definition) {
  return {
    name: definition.resource_name || `${target}.json`,
    description: managedDescription(definition.resource_description || `【試行中】\nレポっとの投稿記録です。日時、位置情報、コメント、写真URL等を収録しています。`, tableMarker(target)),
  };
}

function imageMetadata(image, definition = {}) {
  const tag = definition.source_tag ? `「${definition.source_tag}」タグの` : '';
  const source = definition.source_url || 'https://repot-archive.cocolab.jp/';
  const description = `【試行中】\nレポっとに投稿された${tag}写真です。記録日時、位置情報、コメント等は、投稿データの同じファイル名の行を参照してください。\n出典：レポっと Archives\n${source}\nクレジット：© repot contributors (modified)`;
  return {
    name: imageName(image.filename),
    description: managedDescription(description, `${IMAGE_MARKER}${JSON.stringify({ filename: image.filename, sha256: image.sha256 })}`),
  };
}

function readImageMetadata(description) {
  if (typeof description !== 'string') throw new Error('画像の管理情報がありません。');
  const raw = description.startsWith(IMAGE_MARKER) ? description.slice(IMAGE_MARKER.length)
    : description.match(/<!--\s*repot-image-v1:(\{[\s\S]*?\})\s*-->/)?.[1];
  if (!raw) throw new Error('画像の管理情報がありません。');
  const result = JSON.parse(raw);
  if (typeof result?.filename !== 'string' || !/^[0-9a-f]{64}$/.test(result?.sha256)) {
    throw new Error('画像の管理情報が不正です。');
  }
  return result;
}

function csvMetadata(target, definition, metadata) {
  const source = definition.source_url || 'https://repot-archive.cocolab.jp/';
  return {
    name: `${definition.resource_name || target}_CSV`,
    description: managedDescription(`【試行中】\n投稿データの全17項目をCSV形式で収録しています。JSON形式の投稿表を更新した後の全件を出力しています。文字コードはUTF-8（BOM付き）、行の区切りはCRLFです。空欄は空文字または欠損値を表します。日時はUTCです。\n出典：レポっと Archives\n${source}\nクレジット：© repot contributors (modified)`,
      `${CSV_MARKER}${JSON.stringify({ target, table_resource_id: metadata.table_resource_id, sha256: metadata.sha256 })}`),
  };
}

function readCsvMetadata(description) {
  const raw = typeof description === 'string'
    ? description.match(/<!--\s*repot-csv-v1:(\{[\s\S]*?\})\s*-->/)?.[1] : null;
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (!['komaruKurage', 'chushikokuSakana'].includes(value?.target)
      || typeof value.table_resource_id !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error('CSVの管理情報が不正です。');
  }
  return value;
}

module.exports = { datasetMarker, tableMarker, imageName, legacyImageName, managedDescription,
  datasetMetadata, tableMetadata, imageMetadata, readImageMetadata, csvMetadata, readCsvMetadata, normalizeMetadataText };
