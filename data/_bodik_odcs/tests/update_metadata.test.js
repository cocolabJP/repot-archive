'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { run } = require('../update_metadata');

test('旧メタデータ用入口も、無通信でCSV専用の確認結果を生成する', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odcs-metadata-'));
  try {
    let output = '';
    await run(['--dry-run', '--csv-dir', directory], { env: {}, stdout: { write: (value) => { output += value; } },
      stderr: { write() {} }, fetchImpl: async () => assert.fail('通信禁止') });
    const plan = JSON.parse(output);
    assert.equal(plan.type, 'repot-odcs-csv-only-plan-v1');
    assert.equal(plan.datasets.length, 2);
    assert.ok(plan.datasets.every((item) => fs.existsSync(item.csv_path)));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
