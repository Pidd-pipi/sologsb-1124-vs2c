/**
 * 合并语义集成测试的运行器：用 esbuild 把 TS 测试（含 @ 别名）打成单文件后在 Node 中执行。
 * 用法：node test/run.mjs（依赖 fake-indexeddb，devDependencies 提供）。
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rm } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outfile = resolve(here, '.merge.bundle.mjs')

await build({
  entryPoints: [resolve(here, 'merge.spec.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
  alias: {
    '@': resolve(root, 'src')
  }
})

try {
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(outfile, { force: true })
}
