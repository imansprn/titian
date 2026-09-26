'use strict';
const assert = require('node:assert/strict');
const sharp = require('./dependencies/node_modules/sharp');
const ExcelJS = require('./dependencies/node_modules/exceljs');
(async () => {
  const png = await sharp({create:{width:8,height:6,channels:3,background:'#2468ac'}}).png().toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width,8); assert.equal(metadata.height,6);
  const resized = await sharp(png).resize(4,3).png().toBuffer();
  assert.equal((await sharp(resized).metadata()).width,4);
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Smoke');
  sheet.getCell('A1').value='round trip'; sheet.getCell('B1').value=42;
  const bytes=await book.xlsx.writeBuffer(); const restored=new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  assert.equal(restored.worksheets[0].getCell('A1').value,'round trip');
  assert.equal(restored.worksheets[0].getCell('B1').value,42);
  console.log('Patched image and spreadsheet dependencies: PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});
