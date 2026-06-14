/* Regenerate tests/fixtures/sample.pdf — a tiny, UNCOMPRESSED, born-digital PDF
   with two text runs, so the pdf-text adapter's built-in extractor (and any real
   pdf.js) can read it end-to-end with no network and no dependency.

       node tests/fixtures/make-sample-pdf.js

   Two runs: "Hello Cleo" at 24pt and "Adapter contract proof" at 12pt. */
'use strict';
const fs = require('fs');
const path = require('path');

const content =
  'BT\n/F1 24 Tf\n72 700 Td\n(Hello Cleo) Tj\nET\n' +
  'BT\n/F1 12 Tf\n72 680 Td\n(Adapter contract proof) Tj\nET\n';

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  '<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets[i] = pdf.length;
  pdf += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
});
const xrefStart = pdf.length;
pdf += 'xref\n0 ' + (objects.length + 1) + '\n';
pdf += '0000000000 65535 f \n';
offsets.forEach(off => { pdf += String(off).padStart(10, '0') + ' 00000 n \n'; });
pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\n';
pdf += 'startxref\n' + xrefStart + '\n%%EOF\n';

const out = path.join(__dirname, 'sample.pdf');
fs.writeFileSync(out, Buffer.from(pdf, 'latin1'));
console.log('wrote', path.relative(path.join(__dirname, '..', '..'), out), '(' + pdf.length + ' bytes)');
