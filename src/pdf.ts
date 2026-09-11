import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function pdfToPng(pdf: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'receipt-'))
  try {
    const src = join(dir, 'in.pdf')
    await writeFile(src, pdf)
    await run('pdftoppm', ['-png', '-singlefile', '-r', '110', '-f', '1', '-l', '1', src, join(dir, 'out')], { timeout: 30_000 })
    return await readFile(join(dir, 'out.png'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
