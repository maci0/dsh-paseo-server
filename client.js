/**
 * dsh-paseo-server browser half.
 *
 * Two surfaces, one component: the Paseo card on a Plugins row, and a Paseo
 * page in Settings. Both render the pairing QR and the pairing
 * strings, so a phone can be pointed at this daemon without a terminal. The QR
 * is an SVG document served by the host half, so the browser half carries no
 * encoder and no QR dependency.
 *
 * This file is plain JavaScript on purpose. The client module system serves a
 * package's `exports["./client"]` artifact as a lazy-CJS factory registered on
 * `window.__ModuleLoader__`; `react` is provided by the module system and
 * nothing else is required.
 */

window.__ModuleLoader__.load({
  id: '@maci0/dsh-paseo-server',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Locale namespace for this plugin's copy. */
    const LOCALE_NS = 'paseo-server'

    /** Host route reporting the current pairing offer. */
    const PAIRING_ROUTE = '/paseo/pairing'

    /** Host route serving the pairing QR as SVG. */
    const QR_ROUTE = '/paseo/pairing.svg'

    /** Card stylesheet. Appended once per card mount; the module system removes the tag on unload. */
    const STYLE_ID = 'dsh-paseo-server-style'

    /** Global panel id shared by the sidebar entry and the page it opens. */
    const PANEL_ID = 'paseo'

    /** Settings namespace of this plugin's row, which the page's config form edits. */
    const CONFIG_NAMESPACE = 'paseo-server'

    /**
     * Config fields the page edits, in display order. `kind` picks the control:
     * a checkbox, a text input, or a comma-separated list.
     */
    const FIELDS = [
      { path: 'enabled', kind: 'boolean', label: 'fieldEnabled' },
      { path: 'relayEnabled', kind: 'boolean', label: 'fieldRelayEnabled' },
      { path: 'relayUseTls', kind: 'boolean', label: 'fieldRelayUseTls' },
      { path: 'relayEndpoint', kind: 'string', label: 'fieldRelayEndpoint' },
      { path: 'appBaseUrl', kind: 'string', label: 'fieldAppBaseUrl' },
      { path: 'wsPath', kind: 'string', label: 'fieldWsPath' },
      { path: 'passwordEnv', kind: 'string', label: 'fieldPasswordEnv' },
      { path: 'dataDir', kind: 'string', label: 'fieldDataDir' },
      { path: 'defaultProvider', kind: 'string', label: 'fieldDefaultProvider' },
      { path: 'defaultModel', kind: 'string', label: 'fieldDefaultModel' },
      { path: 'allowedOrigins', kind: 'list', label: 'fieldAllowedOrigins' },
    ]

    const en = {
      meta: {
        title: 'Paseo',
        description: 'Drive DeepSeek Harness agents from the Paseo mobile app over the relay.',
      },
      qrAlt: 'Pairing QR code',
      scan: 'Scan this code in the Paseo app, or open the link.',
      link: 'Pairing link',
      uri: 'CLI target',
      copy: 'Copy',
      copied: 'Copied',
      loading: 'Reading pairing offer...',
      offline: 'The host half is not serving pairing information.',
      relayOn: 'Relay enabled',
      relayOff: 'Relay disabled',
      serverId: 'Server id',
      refresh: 'Refresh',
      tab: 'Paseo',
      summary: 'Scan the pairing QR, or copy the pairing link into the Paseo app.',
      open: 'Open in Paseo',
      download: 'Save QR as SVG',
      hint: 'Keep the pairing link private. Relay and LAN connections also require the daemon password.',
      panel: 'Paseo',
      panelSubtitle: 'Pair a phone, and tune how this daemon reaches the relay.',
      configTitle: 'Configuration',
      configHint: 'Saved to the profile patch. Restart dsh web to apply a change to the running daemon.',
      save: 'Save',
      saved: 'Saved.',
      refused: 'The settings document refused the change.',
      configUnavailable: 'Configuration is not available in this deployment.',
      fieldEnabled: 'Enabled',
      fieldRelayEnabled: 'Relay enabled',
      fieldRelayUseTls: 'Relay uses TLS',
      fieldRelayEndpoint: 'Relay endpoint',
      fieldAppBaseUrl: 'App base URL',
      fieldWsPath: 'WebSocket path',
      fieldPasswordEnv: 'Password variable',
      fieldDataDir: 'Data directory',
      fieldDefaultProvider: 'Default provider',
      fieldDefaultModel: 'Default model',
      fieldAllowedOrigins: 'Allowed origins',
    }

    const zh = {
      meta: {
        title: 'Paseo',
        description: '通过中继，在 Paseo 手机应用中操控 DeepSeek Harness 智能体。',
      },
      qrAlt: '配对二维码',
      scan: '在 Paseo 应用中扫描此二维码，或打开链接。',
      link: '配对链接',
      uri: 'CLI 目标',
      copy: '复制',
      copied: '已复制',
      loading: '正在读取配对信息...',
      offline: '宿主半未提供配对信息。',
      relayOn: '中继已启用',
      relayOff: '中继已禁用',
      serverId: '服务器 ID',
      refresh: '刷新',
      tab: 'Paseo',
      summary: '扫描配对二维码，或将配对链接复制到 Paseo 应用中。',
      open: '在 Paseo 中打开',
      download: '下载二维码 SVG',
      hint: '请妥善保管配对链接。中继和局域网连接还需要守护进程密码。',
      panel: 'Paseo',
      panelSubtitle: '为手机配对，并调整此守护进程连接中继的方式。',
      configTitle: '配置',
      configHint: '保存到配置补丁。重启 dsh web 后改动才会作用于运行中的守护进程。',
      save: '保存',
      saved: '已保存。',
      refused: '设置文档拒绝了此改动。',
      configUnavailable: '此部署不提供配置。',
      fieldEnabled: '启用',
      fieldRelayEnabled: '启用中继',
      fieldRelayUseTls: '中继使用 TLS',
      fieldRelayEndpoint: '中继地址',
      fieldAppBaseUrl: '应用基础地址',
      fieldWsPath: 'WebSocket 路径',
      fieldPasswordEnv: '密码变量名',
      fieldDataDir: '数据目录',
      fieldDefaultProvider: '默认提供方',
      fieldDefaultModel: '默认模型',
      fieldAllowedOrigins: '允许的来源',
    }

    /** Inject the card stylesheet once. */
    function installStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.dps-card{display:flex;flex-direction:column;gap:12px}',
        '.dps-row{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}',
        '.dps-qr{width:200px;height:200px;background:#fff;padding:8px;border-radius:8px}',
        '.dps-meta{display:flex;flex-direction:column;gap:8px;min-width:260px;flex:1}',
        '.dps-label{font-size:12px;opacity:.7}',
        '.dps-value{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}',
        '.dps-hint{font-size:12px;opacity:.7}',
        '.dps-warn{font-size:12px;opacity:.8}',
        '.dps-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
        '.dps-badge{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid currentColor;opacity:.8;align-self:flex-start;width:auto}',
        '.dps-action{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}',
        '.dps-actions a{font-size:12px}',
        '.dps-title{font-size:14px;font-weight:600}',
        '.dps-panel{display:flex;flex-direction:column;height:100%;overflow:auto;box-sizing:border-box;padding:24px 32px}',
        '.dps-panel-inner{display:flex;flex-direction:column;gap:16px;width:100%;max-width:920px}',
        '.dps-panel-title{font-size:20px;line-height:1.4;font-weight:600;margin:0}',
        '.dps-panel-subtitle{font-size:13px;line-height:1.5;margin:0;opacity:.7}',
        '.dps-section-title{font-size:14px;line-height:1.5;font-weight:600;margin:8px 0 0}',
        '.dps-form{display:flex;flex-direction:column;gap:10px}',
        '.dps-field{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
        '.dps-field-label{font-size:13px;min-width:170px}',
        '.dps-field input[type=text]{font:inherit;font-size:13px;padding:4px 10px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;min-width:260px;flex:1}',
        '.dps-field input[type=checkbox]{width:16px;height:16px}',
        '.dps-status{font-size:12px;opacity:.7}',
        '.dps-error{font-size:12px;color:var(--dsw-alias-label-error)}',
      ].join('')
      document.head.appendChild(style)
    }

    /** Copy text, reporting whether the clipboard accepted it. */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    /** One labelled, copyable value. */
    function Value(props) {
      const { label, value, copyLabel, copiedLabel } = props
      const [copied, setCopied] = React.useState(false)
      return React.createElement(
        'div',
        null,
        React.createElement('div', { className: 'dps-label' }, label),
        React.createElement('div', { className: 'dps-row' },
          React.createElement('span', { className: 'dps-value' }, value),
          React.createElement('button', {
            type: 'button',
            className: 'dps-action',
            onClick: async () => {
              const ok = await copyText(value)
              if (!ok) return
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            },
          }, copied ? copiedLabel : copyLabel),
        ),
      )
    }

    /**
     * Bind one settings scope to a React subscription.
     * @param scope - the scope bound to this plugin's settings namespace.
     * @returns a hook reading that scope's current snapshot.
     */
    function useScope(scope) {
      const subscribe = (listener) => scope.subscribe(listener)
      const getSnapshot = () => scope.getSnapshot()
      return () => React.useSyncExternalStore(subscribe, getSnapshot)
    }

    /**
     * Render one field's stored value as editable text.
     * @param kind - the field's control kind.
     * @param value - the stored value.
     * @returns the text the input shows.
     */
    function fieldText(kind, value) {
      if (kind === 'list') return Array.isArray(value) ? value.join(', ') : ''
      return value === undefined || value === null ? '' : String(value)
    }

    /**
     * Turn one field's typed text into the value the settings document stores.
     * @param kind - the field's control kind.
     * @param text - what the input holds.
     * @returns the list or the text itself.
     */
    function fieldValue(kind, text) {
      if (kind !== 'list') return text
      return text.split(',').map((part) => part.trim()).filter((part) => part !== '')
    }

    /**
     * The configuration form over this plugin's row.
     *
     * Only the fields the user touched are written, as one revision-fenced
     * mutation, so a stale page cannot silently rewrite a field it never showed
     * the user. A field whose namespace the deployment does not serve renders a
     * notice instead of an empty form.
     * @param scope - the settings scope for this plugin's namespace.
     * @param t - translate function bound to this plugin's locale namespace.
     * @returns the form component the page renders.
     */
    function createConfigForm(scope, t) {
      const useForm = useScope(scope)

      return function PaseoConfig() {
        const snapshot = useForm()
        const [draft, setDraft] = React.useState({})
        const [status, setStatus] = React.useState(null)
        const [pending, setPending] = React.useState(false)

        if (snapshot.status !== 'ready') {
          return React.createElement(
            'div',
            { className: 'dps-hint' },
            snapshot.status === 'loading' ? t('loading') : t('configUnavailable'),
          )
        }

        const stored = snapshot.value ?? {}
        const disabled = !snapshot.writable || pending
        const current = (field) => Object.hasOwn(draft, field.path) ? draft[field.path] : stored[field.path]
        const dirty = FIELDS.filter((field) => Object.hasOwn(draft, field.path))
        const edit = (field, next) => {
          setStatus(null)
          setDraft({ ...draft, [field.path]: next })
        }
        const save = () => {
          if (disabled || dirty.length === 0) return
          setPending(true)
          setStatus(null)
          scope.mutate(dirty.map((field) => ({ op: 'set', path: [field.path], value: current(field) })))
            .then((accepted) => {
              setStatus(accepted === false ? 'refused' : 'saved')
              if (accepted !== false) setDraft({})
            })
            .catch((error) => { setStatus(error instanceof Error ? error.message : String(error)) })
            .finally(() => { setPending(false) })
        }

        return React.createElement(
          'div',
          { className: 'dps-form' },
          ...FIELDS.map((field) => React.createElement(
            'label',
            { className: 'dps-field', key: field.path, htmlFor: 'dps-field-' + field.path },
            React.createElement('span', { className: 'dps-field-label' }, t(field.label)),
            field.kind === 'boolean'
              ? React.createElement('input', {
                id: 'dps-field-' + field.path,
                type: 'checkbox',
                checked: current(field) === true,
                disabled,
                onChange: (event) => { edit(field, event.target.checked) },
              })
              : React.createElement('input', {
                id: 'dps-field-' + field.path,
                type: 'text',
                value: fieldText(field.kind, current(field)),
                disabled,
                onChange: (event) => { edit(field, fieldValue(field.kind, event.target.value)) },
              }),
          )),
          React.createElement(
            'div',
            { className: 'dps-actions' },
            React.createElement('button', {
              type: 'button',
              className: 'dps-action',
              disabled: disabled || dirty.length === 0,
              onClick: save,
              id: 'dps-save',
            }, t('save')),
            React.createElement(
              'span',
              { className: status === 'refused' ? 'dps-error' : 'dps-status' },
              status === null || status === 'saved' ? (status === 'saved' ? t('saved') : '') : (status === 'refused' ? t('refused') : status),
            ),
          ),
        )
      }
    }

    /**
     * Build the global page behind the sidebar entry: the pairing card and the
     * configuration form, under one title.
     * @param Card - the pairing card component.
     * @param Config - the configuration form component.
     * @param t - translate function bound to this plugin's locale namespace.
     * @returns the page component the `main` slot renders.
     */
    function createPage(Card, Config, t) {
      return function PaseoPanel() {
        return React.createElement(
          'div',
          { className: 'dps-panel' },
          React.createElement(
            'div',
            { className: 'dps-panel-inner' },
            React.createElement('h1', { className: 'dps-panel-title' }, t('panel')),
            React.createElement('p', { className: 'dps-panel-subtitle' }, t('panelSubtitle')),
            React.createElement(Card, { view: 'page' }),
            React.createElement('h2', { className: 'dps-section-title' }, t('configTitle')),
            React.createElement('p', { className: 'dps-hint' }, t('configHint')),
            React.createElement(Config, null),
          ),
        )
      }
    }

    /**
     * Decorative occupant for the sidebar entry; the sidebar owns the
     * accessible label.
     * @param props - the sidebar's icon share: the requested edge size.
     * @returns the handset glyph.
     */
    function PanelIcon(props) {
      const size = props?.size ?? 16
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('rect', { x: 4, y: 1.5, width: 8, height: 13, rx: 2 }),
        React.createElement('path', { d: 'M8 12h0.01' }),
      )
    }

    /**
     * The Paseo pairing card.
     *
     * A Plugins row renders the summary view on its own page, so the same
     * component answers both without a second implementation.
     */
    function createCard(t) {
      return function PaseoCard(props) {
        const view = props && props.view === 'summary' ? 'summary' : 'page'
        const [state, setState] = React.useState({ phase: 'loading' })
        const load = React.useCallback(async () => {
          try {
            const response = await fetch(PAIRING_ROUTE, { headers: { accept: 'application/json' } })
            if (!response.ok) throw new Error(String(response.status))
            setState({ phase: 'ready', info: await response.json() })
          } catch {
            setState({ phase: 'offline' })
          }
        }, [])
        React.useEffect(() => {
          installStyle()
          void load()
        }, [load])

        if (state.phase === 'loading') {
          return React.createElement('div', { className: 'dps-card' }, t('loading'))
        }
        if (state.phase === 'offline') {
          return React.createElement('div', { className: 'dps-card' }, t('offline'))
        }
        const info = state.info
        const qrSrc = QR_ROUTE + '?v=' + encodeURIComponent(info.serverId)
        if (view === 'summary') {
          return React.createElement('div', { className: 'dps-hint' }, t('summary'))
        }
        return React.createElement(
          'div',
          { className: 'dps-card' },
          React.createElement('div', { className: 'dps-row' },
            React.createElement('img', {
              className: 'dps-qr',
              src: qrSrc,
              alt: t('qrAlt'),
            }),
            React.createElement('div', { className: 'dps-meta' },
              React.createElement('div', { className: 'dps-hint' }, t('scan')),
              React.createElement('span', { className: 'dps-badge' }, info.relayEnabled ? t('relayOn') : t('relayOff')),
              React.createElement('div', null,
                React.createElement('div', { className: 'dps-label' }, t('serverId')),
                React.createElement('div', { className: 'dps-value' }, info.serverId),
              ),
              React.createElement(Value, {
                label: t('link'),
                value: info.url,
                copyLabel: t('copy'),
                copiedLabel: t('copied'),
              }),
              React.createElement(Value, {
                label: t('uri'),
                value: info.uri,
                copyLabel: t('copy'),
                copiedLabel: t('copied'),
              }),
              React.createElement('div', { className: 'dps-actions' },
                React.createElement('button', { type: 'button', onClick: () => { void load() } }, t('refresh')),
                React.createElement('a', { href: info.url, target: '_blank', rel: 'noreferrer' }, t('open')),
                React.createElement('a', { href: qrSrc, download: 'paseo-pairing.svg' }, t('download')),
              ),
              React.createElement('div', { className: 'dps-warn' }, t('hint')),
            ),
          ),
        )
      }
    }

    /**
     * Mount the pairing and configuration surfaces.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'dsh-paseo-server: locale dictionary')
      const Card = createCard(t)
      const Config = createConfigForm(ctx.configForms.get(CONFIG_NAMESPACE), t)
      const Page = createPage(Card, Config, t)

      // The Plugins row card. `${package}#${rowId}` is the identity the Plugins
      // page looks up for a row; any other key registers a card nothing renders.
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: '@maci0/dsh-paseo-server#paseo-server',
        locale: LOCALE_NS,
      }, Card))

      // The Settings page, where the QR is reachable without opening a bundle
      // row. The Plugins page skips it because the row registers its own card.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'paseo',
        order: 30,
        label: () => t('tab'),
        locale: LOCALE_NS,
      }, Card))

      // The sidebar entry and the page it opens: pairing plus configuration,
      // reachable without going through the Plugins or Settings pages.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NS,
      }, Page))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        locale: LOCALE_NS,
        label: () => t('panel'),
      }, PanelIcon))
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms', 'locale']
    return module.exports
  },
})
