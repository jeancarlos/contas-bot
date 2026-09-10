import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { pdfToPng } from '../src/pdf.ts'

const MINIMAL_PDF = Buffer.from(
`%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj
trailer<</Root 1 0 R>>`)

let hasPoppler = true
try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }) } catch { hasPoppler = false }

test('pdfToPng renders the first page', { skip: !hasPoppler && 'pdftoppm not installed' }, async () => {
  const png = await pdfToPng(MINIMAL_PDF)
  assert.deepEqual(png.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
})
