'use strict';

// _id は DataStore が自動付与するため、送信データ・CSVには含めない。
const RECORD_FIELDS = Object.freeze([
  'id', 'timestamp', 'lat', 'lon', 'caption', 'image_url', 'created_at', 'updated_at', 'deleted_at',
]);
const NUMERIC_FIELDS = new Set(['id', 'timestamp', 'lat', 'lon']);
const DATASTORE_FIELDS = RECORD_FIELDS.map((id) => ({ id, type: NUMERIC_FIELDS.has(id) ? 'numeric' : 'text' }));

function assertRecordFields(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('投稿はオブジェクトが必要です。');
  const missing = RECORD_FIELDS.filter((field) => !Object.hasOwn(record, field));
  const extra = Object.keys(record).filter((field) => !RECORD_FIELDS.includes(field));
  if (missing.length || extra.length) {
    throw new Error(`投稿は最新スキーマの9項目が必要です（不足: ${missing.join(', ') || 'なし'} / 対象外: ${extra.join(', ') || 'なし'}）。_id は送信しません。`);
  }
}

function assertTableFields(fields) {
  if (!Array.isArray(fields)) throw new Error('送信先の列情報が取得できませんでした。');
  const names = fields.map((field) => field.id);
  const missing = RECORD_FIELDS.filter((field) => !names.includes(field));
  const extra = names.filter((field) => field !== '_id' && !RECORD_FIELDS.includes(field));
  if (missing.length || extra.length) {
    throw new Error(`送信先の列が最新スキーマと一致しません（不足: ${missing.join(', ') || 'なし'} / 対象外: ${extra.join(', ') || 'なし'}）。送信先を _id と9項目に整備してください。既存の列・データは自動削除しません。`);
  }
}

// filename 列を送らず、画像URLの末尾からローカル画像との対応を取る。
function imageFilename(value) {
  let url;
  let filename;
  try {
    url = new URL(value);
    filename = decodeURIComponent(url.pathname.split('/').pop());
  } catch {
    throw new Error('画像URLまたは画像ファイル名が不正です。');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || !filename || /[\\/\0]/.test(filename) || /^\.{1,2}$/.test(filename)) {
    throw new Error('画像URLまたは画像ファイル名が不正です。');
  }
  return filename;
}

module.exports = { RECORD_FIELDS, DATASTORE_FIELDS, assertRecordFields, assertTableFields, imageFilename };
