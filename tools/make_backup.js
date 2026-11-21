/**
 * 从《冻干排班.xlsx》生成可直接「从备份恢复」的 JSON。
 * 用法：node tools/make_backup.js
 * 输出：备份-冻干排班.json（不提交到仓库，含真实姓名）
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const XLSX = require(path.join(ROOT, 'docs', 'xlsx.full.min.js'));
global.XLSX = XLSX;
const EP = require(path.join(ROOT, 'docs', 'excel_parse.js'));
const Importer = require(path.join(ROOT, 'docs', 'importer.js'));
const { migrate, EMPTY_STATE } = require(path.join(ROOT, 'docs', 'store.js'));

const xlsxPath = path.join(ROOT, '冻干排班.xlsx');
if (!fs.existsSync(xlsxPath)) {
  console.error('未找到 冻干排班.xlsx');
  process.exit(1);
}

const state = migrate(EMPTY_STATE());
const buf = fs.readFileSync(xlsxPath);
const staged = Importer.preview(
  state,
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  '冻干排班.xlsx'
);

const stats = Importer.commitSync(state, staged, {
  mapping: staged.mapping,
  replace: true,
  auto_create: true,
});

console.log('解析:', staged.summary);
console.log('写入:', stats);

// 统计起点设为今天（历史只累计，从今天起用 App 排班）
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
state.settings.stats_start_date = today;
console.log('统计起点:', today);

const out = path.join(ROOT, `备份-冻干排班-${today}.json`);
fs.writeFileSync(out, Importer.exportBackup(state), 'utf8');
console.log('已生成:', path.basename(out), Math.round(fs.statSync(out).size / 1024) + ' KB');
console.log('使用：打开网页 → 人员 → 从备份恢复 → 选择该文件');
