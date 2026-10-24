import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publishOrder } from './publish-order.mjs'

function workspace(packages) {
  const root = mkdtempSync(path.join(tmpdir(), 'publish-order-'))
  for (const [directory, manifest] of Object.entries(packages)) {
    mkdirSync(path.join(root, directory), { recursive: true })
    writeFileSync(path.join(root, directory, 'package.json'), JSON.stringify(manifest))
  }
  return root
}

test('each public package follows its workspace dependencies and peers', (t) => {
  const root = workspace({
    'extensions/a-tools': { name: '@x/a-tools', dependencies: { '@x/repo': '^1.0.0', lodash: '^4' } },
    'extensions/b-agent': { name: '@x/b-agent', peerDependencies: { '@x/a-tools': '^1.0.0' }, dependencies: { '@x/process': '^1' } },
    'packages/repo': { name: '@x/repo', dependencies: { '@x/process': '^1.0.0' } },
    'packages/process': { name: '@x/process' },
    'website': { name: '@x/docs', private: true },
    'extensions/private': { name: '@x/private', private: true },
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.deepEqual(publishOrder(root), [
    'packages/process/package.json',
    'packages/repo/package.json',
    'extensions/a-tools/package.json',
    'extensions/b-agent/package.json',
  ])
})

test('a dependency cycle has no publish order', (t) => {
  const root = workspace({
    'packages/a': { name: '@x/a', dependencies: { '@x/b': '^1' } },
    'packages/b': { name: '@x/b', dependencies: { '@x/a': '^1' } },
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.throws(() => publishOrder(root), /Workspace dependency cycle: @x\/a -> @x\/b -> @x\/a/)
})

test('the repository has a publish order', () => {
  const order = publishOrder()
  assert.ok(order.indexOf('packages/pi-process/package.json') < order.indexOf('extensions/pi-subagent/package.json'))
  assert.ok(order.indexOf('packages/pi-repo/package.json') < order.indexOf('extensions/pi-herdr-tools/package.json'))
})
