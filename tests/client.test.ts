/**
 * Browser-half tests.
 *
 * `client.js` is evaluated the way the client module system evaluates it: a
 * lazy-CJS factory registered on `window.__ModuleLoader__`, over a React stand-in
 * and a fake browser plugin context. That covers the slot wiring, the pairing
 * read, and the configuration write without a browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

/** One element as the stand-in React builds it. */
interface Element {
  type: string | ((props: Record<string, unknown>) => unknown)
  props: Record<string, unknown> & { children?: unknown }
}

/** The exports the client module publishes to the module system. */
interface ClientExports {
  apply(ctx: FakeContext): void
  inject: readonly string[]
}

/** The pairing payload the host route answers with. */
const PAIRING = {
  serverId: 'srv_test',
  url: 'https://app.paseo.sh/#offer=x',
  uri: 'relay://relay.paseo.sh:443/srv_test?key=k',
  relayEnabled: true,
}

/** One slot registration as the fake registry recorded it. */
interface Registration {
  spec: Record<string, unknown>
  component: (props?: Record<string, unknown>) => unknown
}

/** The pieces of the browser plugin context this plugin reaches for. */
interface FakeContext {
  locale: {
    bind(ns: string): (key: string, params?: Record<string, string>) => string
    register(ns: string, dictionaries: Record<string, unknown>): () => void
  }
  configForms: { get(ns: string): FakeScope }
  slots: {
    inject(name: string, register: () => void): void
    register(spec: Record<string, unknown>, component: Registration['component']): () => void
  }
  effect(callback: () => (() => void) | void, label: string): void
}

/** The settings scope shape the config form reads and writes. */
interface FakeScope {
  getSnapshot(): Record<string, unknown>
  subscribe(listener: () => void): () => void
  mutate(ops: readonly Record<string, unknown>[]): Promise<boolean>
}

/** Hook cells shared by every component in one render pass. */
const hooks: { cells: unknown[], index: number } = { cells: [], index: 0 }

/** Minimal React: element trees plus the five hooks the client half uses. */
const React = {
  createElement(type: Element['type'], props: Record<string, unknown> | null, ...children: unknown[]): Element {
    return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
  },
  useState(initial: unknown): [unknown, (next: unknown) => void] {
    const cell = hooks.index++
    if (!Object.hasOwn(hooks.cells, cell)) {
      hooks.cells[cell] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    }
    return [hooks.cells[cell], (next: unknown): void => {
      hooks.cells[cell] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(hooks.cells[cell]) : next
    }]
  },
  useCallback(callback: unknown): unknown {
    return callback
  },
  useEffect(callback: () => void): void {
    callback()
  },
  useSyncExternalStore(_subscribe: () => () => void, getSnapshot: () => unknown): unknown {
    return getSnapshot()
  },
}

/** The document stub `installStyle` needs; nothing else in the client uses it. */
function installDocument(): { styles: number } {
  const state = { styles: 0 }
  const document = {
    getElementById(): null {
      return null
    },
    createElement(): Record<string, unknown> {
      return { setAttribute(): void {}, textContent: '', id: '' }
    },
    head: {
      appendChild(): void {
        state.styles += 1
      },
    },
  }
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true })
  return state
}

/** Load the client module once and return the registration it published. */
async function loadRegistration(): Promise<{ id: string, factory: (require: (id: string) => unknown) => ClientExports }> {
  let captured: { id: string, factory: (require: (id: string) => unknown) => ClientExports } | undefined
  Object.defineProperty(globalThis, 'window', {
    value: { __ModuleLoader__: { load: (spec: typeof captured): void => { captured = spec } } },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'fetch', {
    value: async (): Promise<unknown> => ({ ok: true, json: async (): Promise<unknown> => PAIRING }),
    configurable: true,
    writable: true,
  })
  await import('../client.js')
  if (captured === undefined) throw new Error('client.js registered nothing')
  return captured
}

/** The module system imports the artifact once, so every case shares one registration. */
const registration = await loadRegistration()

/** One fake context over one mutable settings snapshot. */
function createContext(options: { status?: string, value?: Record<string, unknown> } = {}): {
  ctx: FakeContext
  registrations: Registration[]
  injected: string[]
  mutations: Record<string, unknown>[][]
} {
  const state = {
    status: options.status ?? 'ready',
    value: options.value ?? {
      enabled: true,
      relayEnabled: true,
      relayUseTls: true,
      relayEndpoint: 'relay.paseo.sh:443',
      allowedOrigins: ['https://app.paseo.sh'],
    },
    writable: true,
  }
  const mutations: Record<string, unknown>[][] = []
  const scope: FakeScope = {
    getSnapshot: () => ({ ...state, revision: 1 }),
    subscribe: () => () => {},
    mutate: async (ops) => {
      mutations.push([...ops])
      return true
    },
  }
  const registrations: Registration[] = []
  const injected: string[] = []
  const ctx: FakeContext = {
    locale: {
      bind: () => (key: string, params: Record<string, string> = {}) => {
        const names = Object.keys(params)
        return names.length === 0 ? key : key + ':' + names.map((name) => String(params[name])).join(',')
      },
      register: () => () => {},
    },
    configForms: { get: () => scope },
    slots: {
      inject: (name, register) => {
        injected.push(name)
        register()
      },
      register: (spec, component) => {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    effect: (callback) => { callback() },
  }
  return { ctx, registrations, injected, mutations }
}

/** Render a component function with its own hook frame. */
function mount(component: (props?: Record<string, unknown>) => unknown, props: Record<string, unknown> = {}): unknown {
  hooks.index = 0
  return resolve(component(props))
}

/** Resolve a rendered tree into elements with resolved children. */
function resolve(node: unknown): unknown {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => resolve(child))
  const element = node as Element
  if (typeof element.type === 'function') {
    const saved = hooks.index
    hooks.index = 0
    const rendered = element.type(element.props) as unknown
    hooks.index = saved
    return resolve(rendered)
  }
  return { type: element.type, props: { ...element.props, children: resolve(element.props.children ?? []) } }
}

/** Every element of one type in a rendered tree, depth first. */
function findAll(node: unknown, type: string): Element[] {
  const found: Element[] = []
  const visit = (current: unknown): void => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    const element = current as Element
    if (element.type === type) found.push(element)
    visit(element.props?.children)
  }
  visit(node)
  return found
}

/** The concatenated text of a rendered subtree. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join('')
  return textOf((node as Element).props?.children)
}

/** Assert one lookup found something, narrowing the type. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

/** Settle every pending microtask the pairing read and the write queue schedule. */
function flush(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

test('apply mounts the row card, the settings section, and the sidebar page', async () => {
  installDocument()
  const spec = registration
  assert.equal(spec.id, '@maci0/dsh-paseo-server')
  const { ctx, registrations, injected } = createContext()
  const client = spec.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  client.apply(ctx)

  assert.deepEqual(client.inject, ['slots', 'configForms', 'locale'])
  assert.deepEqual(injected, ['plugins.row.config', 'settings.section', 'main', 'sidebar.panellist'])

  const row = registrations.find((entry) => entry.spec.name === 'plugins.row.config')
  assert.equal(row?.spec.key, '@maci0/dsh-paseo-server#paseo-server')
  const section = registrations.find((entry) => entry.spec.name === 'settings.section')
  assert.equal(section?.spec.id, 'paseo')
  assert.equal((section?.spec.label as () => string)(), 'tab')

  const main = required(registrations.find((entry) => entry.spec.name === 'main'), 'main panel')
  assert.equal(main?.spec.key, 'paseo')
  const entry = registrations.find((record) => record.spec.name === 'sidebar.panellist')
  assert.equal(entry?.spec.id, 'paseo')
  assert.equal(entry?.spec.order, 30)
  assert.equal((entry?.spec.label as () => string)(), 'panel')
  assert.equal((entry?.component({ size: 16 }) as Element).type, 'svg')
})

test('the page pairs the phone and edits the stored configuration', async () => {
  installDocument()
  const spec = registration
  const { ctx, registrations } = createContext()
  const client = spec.factory(() => React)
  client.apply(ctx)
  const main = required(registrations.find((entry) => entry.spec.name === 'main'), 'main panel')

  // The pairing offer is read on mount; the second render has it.
  mount(main?.component)
  await flush()
  const page = mount(main?.component)
  const text = textOf(page)
  assert.match(text, /panel/)
  assert.match(text, /configTitle/)
  assert.match(text, /fieldRelayEndpoint/)

  const qr = findAll(page, 'img')
  assert.equal(qr.length, 1)
  assert.match(String(required(qr[0], 'qr image').props.src), /^\/paseo\/pairing\.svg\?v=srv_test$/u)

  const boxes = findAll(page, 'input').filter((input) => input.props.type === 'checkbox')
  assert.deepEqual(boxes.map((input) => input.props.checked), [true, true, true])
  const save = findAll(page, 'button').find((button) => button.props.id === 'dps-save')
  assert.equal(save?.props.disabled, true)
})

test('saving writes only the fields the user touched', async () => {
  installDocument()
  const spec = registration
  const { ctx, registrations, mutations } = createContext()
  const client = spec.factory(() => React)
  client.apply(ctx)
  const main = required(registrations.find((entry) => entry.spec.name === 'main'), 'main panel')
  mount(main?.component)
  await flush()
  mount(main?.component)

  const enabled = findAll(mount(main?.component), 'input').find((input) => input.props.id === 'dps-field-enabled')
  assert.notEqual(enabled, undefined)
  ;(enabled?.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: false } })

  const withDraft = mount(main?.component)
  const save = findAll(withDraft, 'button').find((button) => button.props.id === 'dps-save')
  assert.equal(save?.props.disabled, false)
  ;(save?.props.onClick as () => void)()
  await flush()

  assert.deepEqual(mutations, [[{ op: 'set', path: ['enabled'], value: false }]])
  assert.match(textOf(mount(main?.component)), /saved/)
})

test('a list field is edited as comma-separated text', async () => {
  installDocument()
  const spec = registration
  const { ctx, registrations, mutations } = createContext()
  const client = spec.factory(() => React)
  client.apply(ctx)
  const main = required(registrations.find((entry) => entry.spec.name === 'main'), 'main panel')
  mount(main?.component)
  await flush()

  const origins = findAll(mount(main?.component), 'input')
    .find((input) => input.props.id === 'dps-field-allowedOrigins')
  assert.equal(origins?.props.value, 'https://app.paseo.sh')
  ;(origins?.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: 'https://app.paseo.sh, paseo://app' },
  })

  const save = findAll(mount(main?.component), 'button').find((button) => button.props.id === 'dps-save')
  ;(save?.props.onClick as () => void)()
  await flush()
  assert.deepEqual(mutations, [[{ op: 'set', path: ['allowedOrigins'], value: ['https://app.paseo.sh', 'paseo://app'] }]])
})

test('a deployment without the namespace says so instead of showing a form', async () => {
  installDocument()
  const spec = registration
  const { ctx, registrations } = createContext({ status: 'unavailable' })
  const client = spec.factory(() => React)
  client.apply(ctx)
  const main = required(registrations.find((entry) => entry.spec.name === 'main'), 'main panel')
  mount(main?.component)
  await flush()
  const page = mount(main?.component)
  assert.match(textOf(page), /configUnavailable/)
  assert.equal(findAll(page, 'input').filter((input) => input.props.id === 'dps-field-enabled').length, 0)
})
