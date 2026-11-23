#!/usr/bin/env node
'use strict';

// CSV専用構成では、名称・説明文もCSVの公開処理で更新する。
// 旧エントリーポイントを残し、画像・JSONを再作成しない。
const { run } = require('./upload_to_odcs');

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    const secret = process.env.CKAN_API_KEY;
    console.error(secret ? error.message.replaceAll(secret, '[redacted]') : error.message);
    process.exitCode = 1;
  });
}

module.exports = { run };
