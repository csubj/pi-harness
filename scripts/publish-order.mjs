import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const WORKSPACE_ROOTS = ['packages', 'extensions']

/**
 * Return the manifest paths of public workspaces in dependency order: each package comes after
 * the workspace packages in its dependencies and peerDependencies. Ties use path order.
 * A dependency cycle throws, because no publish order can satisfy it.
 */
export function publishOrder(root = '.') {
  const packages = new Map()
  for (const workspace of WORKSPACE_ROOTS) {
    const directory = path.join(root, workspace)
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const manifest = path.posix.join(workspace, entry.name, 'package.json')
      if (!entry.isDirectory() || !existsSync(path.join(root, manifest))) continue
      const json = JSON.parse(readFileSync(path.join(root, manifest), 'utf8'))
      if (json.private) continue
      packages.set(json.name, { manifest, needs: Object.keys({ ...json.dependencies, ...json.peerDependencies }) })
    }
  }
  const order = []
  const state = new Map()
  const visit = (name, trail) => {
    if (state.get(name) === 'done') return
    if (state.get(name) === 'visiting') throw new Error(`Workspace dependency cycle: ${[...trail, name].join(' -> ')}`)
    state.set(name, 'visiting')
    for (const dependency of packages.get(name).needs) if (packages.has(dependency)) visit(dependency, [...trail, name])
    state.set(name, 'done')
    order.push(packages.get(name).manifest)
  }
  for (const name of packages.keys()) visit(name, [])
  return order
}

if (import.meta.main) {
  try {
    console.log(publishOrder().join('\n'))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
