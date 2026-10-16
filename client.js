/**
 * dsh-paseo-server browser half.
 *
 * Two surfaces, one component: the Paseo card on a Plugins row, and a Paseo
 * tab in Settings > Plugins. Both render the pairing QR and the pairing
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
     * Mount both pairing surfaces.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'dsh-paseo-server: locale dictionary')
      const Card = createCard(t)

      // The Plugins row card. `${package}#${rowId}` is the identity the Plugins
      // page looks up for a row; any other key registers a card nothing renders.
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: '@maci0/dsh-paseo-server#paseo-server',
        locale: LOCALE_NS,
      }, Card))

      // The Settings > Plugins tab, which is where a plugin's own settings
      // live and where the QR is reachable without opening a bundle row.
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'paseo',
        order: 20,
        label: () => t('tab'),
        locale: LOCALE_NS,
      }, Card))
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
