// Fails if the package's main entry can reach a `cloudflare:` module at runtime. That entry is the half of the package
// apps load outside workerd (a Node build step, a Vite config, a unit test), so `cloudflare:workers` may only be
// imported under `./durable-object`.
//
// It walks the built module graph rather than grepping one file: a re-export that pulled in the Durable Object would
// bring the import in without the entry ever naming it. TypeScript's own scanner reads the specifiers, so a comment or
// a string that mentions the module (as `src/index.ts`'s header does) is not a hit.
//
// Usage: node .github/scripts/check-entry-imports.mjs [entry ...]   (default: dist/index.js)
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

import ts from 'typescript'

const entries = process.argv.length > 2 ? process.argv.slice(2) : ['dist/index.js']
const show = (file) => relative(process.cwd(), file)

let failures = 0
for (const entry of entries) {
  const root = resolve(entry)
  if (!existsSync(root)) {
    console.error(`::error::${entry} does not exist; build the package first`)
    failures++
    continue
  }

  // Breadth-first, remembering who imported each module so a hit can print the chain that reached it.
  const before = failures
  const importedBy = new Map([[root, null]])
  const queue = [root]
  while (queue.length > 0) {
    const file = queue.shift()
    const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
    for (const { fileName: specifier } of importedFiles) {
      if (specifier.startsWith('cloudflare:')) {
        const chain = []
        for (let at = file; at !== null; at = importedBy.get(at)) chain.unshift(show(at))
        console.error(`::error file=${show(file)}::${entry} imports ${specifier} via ${chain.join(' -> ')}`)
        failures++
      } else if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier)
        if (!existsSync(target)) {
          console.error(`::error file=${show(file)}::cannot resolve ${specifier} from ${show(file)}`)
          failures++
        } else if (!importedBy.has(target)) {
          importedBy.set(target, file)
          queue.push(target)
        }
      }
    }
  }
  if (failures === before) {
    console.log(`${entry}: ${importedBy.size} modules reachable, none imports a cloudflare: module`)
  }
}

process.exit(failures > 0 ? 1 : 0)
