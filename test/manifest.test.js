import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'

import { name as pluginName } from '../src/host/index.js'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the package name matches the host export and the patch row', () => {
  assert.equal(manifest.name, 'dsh-plugin-portara')
  assert.equal(pluginName, 'portara-route')
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- insert:/u)
  assert.match(patch, /id: portara-route/u)
  assert.match(patch, /name: dsh-plugin-portara/u)
})

test('both halves are exported and shipped', () => {
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.ok(manifest.files.includes('client.js'))
  assert.ok(manifest.files.includes('src'))
  assert.ok(manifest.files.includes('cordis.patch.yml'))
  assert.ok(manifest.files.includes('locale'))
  assert.ok(manifest.files.includes('icon.svg'))
})

test('display metadata exists in English and Chinese', () => {
  for (const locale of ['en', 'zh']) {
    const dict = JSON.parse(readFileSync(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8'))
    assert.equal(typeof dict.meta.title, 'string')
    assert.ok(dict.meta.title.length > 0)
    assert.equal(typeof dict.meta.description, 'string')
    assert.ok(dict.meta.description.length > 0)
  }
  const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  assert.notEqual(en.meta.title, zh.meta.title)
})

test('the icon is a bounded SVG that renders', () => {
  const iconUrl = new URL('../icon.svg', import.meta.url)
  const bytes = statSync(iconUrl).size
  assert.ok(bytes > 0 && bytes <= 256 * 1024, `icon size ${bytes}`)
  const text = readFileSync(iconUrl, 'utf8')
  assert.match(text, /^<svg[\s>]/u)
  assert.match(text, /viewBox="0 0 64 64"/u)
  assert.match(text, /<\/svg>\s*$/u)
})

test('the README documents the install and the silent contract', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /dsh plugin install/u)
  assert.match(readme, /Silent by contract/u)
  assert.match(readme, /plugin:portara\/route/u)
})
