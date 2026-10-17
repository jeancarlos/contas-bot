// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function pdfToPng(pdf: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'receipt-'))
  try {
    const src = join(dir, 'in.pdf')
    await writeFile(src, pdf)
    await run('pdftoppm', ['-png', '-singlefile', '-scale-to', '1500', '-f', '1', '-l', '1', src, join(dir, 'out')], {
      timeout: 30_000,
      signal,
    })
    return await readFile(join(dir, 'out.png'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
