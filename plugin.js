// Token 消耗面板 — Hermes desktop runtime plugin (disk door: $HERMES_HOME/desktop-plugins/<name>/plugin.js)
//
// 展示：输入总量 / 输出 / 缓存命中 / 缓存未命中 四路 token、缓存命中率、会话费用、余额（手动登记）、
//       会话总量 / API 调用 / 生成速度 / 上下文占用。
//
// 数据来源（均为 Hermes 宿主已采集的权威数据，插件不重复采集）：
//   - host.state.focusedUsage  (reactive) -> input/output/prompt/total tokens, cache_hit_pct,
//       context_used/context_max/context_percent, calls, avg_tps
//   - host.request('session.stats', { session_id }) -> input_tokens / output_tokens /
//       cache_read_tokens / cache_write_tokens / prompt_tokens / total_tokens / model /
//       provider / tokens_per_s / api_calls / context_length / config_context_length
//   - 语义映射（关键，对照 gateway/session_usage.py 与 agent/usage_pricing.py 核实）：
//       Hermes 把 provider 的「缓存命中」落进 cache_read_tokens，把「未缓存的输入」（DeepSeek 的
//       prompt_cache_miss_tokens）落进 input_tokens；cache_write_tokens 是 Anthropic /
//       OpenAI-GPT5.6+ 的「缓存写入（创建）」，DeepSeek 不返回、恒 0。session.stats 另给
//       prompt_tokens = input + cache_read + cache_write（== DeepSeek 的 prompt_tokens 总量）。
//       因此：缓存命中 = cache_read_tokens，缓存未命中 = input_tokens（非零、真实未命中），
//       输入总量 = prompt_tokens。
//   - 费用：session.stats 不返回 cost，本插件按四路 token × 价目表本地计算
//       （micros 整数、roundHalfUp、四路计价，对齐上游 t_153c9039 契约）。
//
// 命中率 = cache_read / prompt_tokens == 缓存命中 ÷ 输入总量（与宿主 cache_hit_pct 同口径）。
import { atom, host, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const PANES_AREA = 'panes'
const POLL_MS = 2000

// ---- 价目表（演示 fixture，非官方定价；可经 storage 的 pricing 键覆盖）----
// 单位：货币 / 百万 token（数值上 == micros/token）。金额内部一律 micros 整数累加，展示才除 1e6。
const DEMO_PRICE_BOOK = {
  version: 'demo-1',
  currency: 'CNY',
  per_tokens: 1000000,
  models: {
    flash: { input: 2, cache_write: 2, cache_read: 0.2, output: 8 },
    pro: { input: 9, cache_write: 9, cache_read: 0.9, output: 27 },
  },
}
// roundHalfUp：sign * round(abs)，防 Math.round(-0.5) === -0（契约口径）。
const roundHalfUp = (x) => (x < 0 ? -Math.round(-x) : Math.round(x))
// 模型 → 档位的演示启发式（非官方映射）。pro/reasoner/r1 → pro，其余 → flash。
const tierFor = (model) => {
  const m = String(model || '').toLowerCase()
  return /reasoner|\br1\b|\bpro\b/.test(m) ? 'pro' : 'flash'
}
// 四路 micros 总额 = Σ roundHalfUp(tokens_i × price_i)，与契约 costOf 一致。
const costMicros = (s, book) => {
  if (!s) return null
  const b = book && book.models ? book : DEMO_PRICE_BOOK
  const price = b.models[tierFor(s.model)] || b.models.flash || { input: 0, cache_write: 0, cache_read: 0, output: 0 }
  const p = (k) => num(price[k]) ?? 0
  return roundHalfUp((num(s.input_tokens) ?? 0) * p('input'))
    + roundHalfUp((num(s.cache_write_tokens) ?? 0) * p('cache_write'))
    + roundHalfUp((num(s.cache_read_tokens) ?? 0) * p('cache_read'))
    + roundHalfUp((num(s.output_tokens) ?? 0) * p('output'))
}

// ---- 插件本地状态 ----
const $stats = atom(null)       // session.stats 结果 (SessionStats) | null
const $statsError = atom(null)  // string | null
const $balance = atom(null)     // { amount:number, currency:'USD'|'CNY' } | null（手动登记）
const $draftBalance = atom('')  // 设置页金额草稿
const $draftCurrency = atom('CNY')
const $pricing = atom(DEMO_PRICE_BOOK) // 价目表（可经 storage 覆盖）

let pluginCtx = null // register() 注入，供 settings 页持久化用

// ---- 数字格式化 ----
const num = (n) => (n == null || Number.isNaN(n) ? null : n)
const fmtInt = (n) => { const v = num(n); return v == null ? '—' : Math.round(v).toLocaleString('en-US') }
const fmtTokens = (n) => {
  const v = num(n)
  if (v == null) return '—'
  const r = Math.round(v)
  if (r >= 1000000) return (r / 1000000).toFixed(r >= 10000000 ? 0 : 1) + 'M'
  if (r >= 1000) return (r / 1000).toFixed(r >= 100000 ? 0 : 1) + 'K'
  return r.toLocaleString('en-US')
}
const fmtMoney = (v, currency) => {
  const x = num(v)
  if (x == null) return '—'
  const sym = currency === 'CNY' ? '¥' : '$'
  const a = Math.abs(x)
  const d = a === 0 ? 2 : a < 0.01 ? 6 : a < 1 ? 4 : 2
  return sym + x.toFixed(d)
}
const fmtBalance = (b) => {
  if (!b || typeof b.amount !== 'number') return '—'
  return (b.currency === 'CNY' ? '¥' : '$') + b.amount.toFixed(2)
}
const fmtPct = (v) => { const x = num(v); return x == null ? '—' : (x * 100).toFixed(1) + '%' }
const tokenSub = (n) => { const v = num(n); return v == null ? null : fmtInt(v) + ' tokens' }

// ---- 数据读取 ----
async function refresh() {
  const sid = host.state.focusedSessionId.get()
  if (!sid) {
    $stats.set(null)
    $statsError.set(null)
    return
  }
  try {
    const raw = await host.request('session.stats', { session_id: sid })
    // 兼容两种返回：直接 result 或 { result }
    const s = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw
    $stats.set(s && typeof s === 'object' ? s : null)
    $statsError.set(null)
  } catch (e) {
    $statsError.set(e && e.message ? e.message : String(e))
  }
}

// ---- 小组件（纯展示，无 hooks）----
function StatTile({ label, value, sub, tone }) {
  const valueCls = tone === 'hit' ? 'text-(--ui-green)' : 'text-(--ui-text-primary)'
  return jsxs('div', { className: 'flex flex-col gap-0.5 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-2.5 py-2', children: [
    jsx('span', { className: 'text-[0.6875rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: label }),
    jsx('span', { className: 'font-semibold tabular-nums ' + valueCls, children: value }),
    sub != null ? jsx('span', { className: 'text-[0.625rem] tabular-nums text-(--ui-text-quaternary)', children: sub }) : null,
  ] })
}

function MetricRow({ label, value, hint }) {
  return jsxs('div', { className: 'flex items-baseline justify-between gap-2 py-0.5', children: [
    jsx('span', { className: 'text-xs text-(--ui-text-secondary)', children: label }),
    jsxs('span', { className: 'flex items-baseline gap-1.5', children: [
      jsx('span', { className: 'text-sm font-semibold tabular-nums text-(--ui-text-primary)', children: value }),
      hint != null ? jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: hint }) : null,
    ] }),
  ] })
}

function HitBar({ rate }) {
  const r = num(rate)
  const width = r == null ? 0 : Math.max(0, Math.min(100, r * 100))
  return jsx('div', { className: 'h-1.5 w-full overflow-hidden rounded-full bg-(--ui-stroke-tertiary)', children: [
    jsx('div', { className: 'h-full rounded-full bg-(--ui-accent) transition-[width]', style: { width: width + '%' } }),
  ] })
}

function Empty() {
  return jsxs('div', { className: 'flex h-full flex-col items-center justify-center gap-2 px-4 text-center', children: [
    jsx('span', { className: 'text-sm font-medium text-(--ui-text-secondary)', children: '暂无会话' }),
    jsx('span', { className: 'text-xs text-(--ui-text-tertiary)', children: '开始一个会话后，这里会实时显示 token 消耗与缓存命中/未命中统计。' }),
  ] })
}

function Loading() {
  return jsx('div', { className: 'flex h-full items-center justify-center', children: [
    jsx('div', { className: 'h-5 w-5 animate-spin rounded-full border-2 border-(--ui-stroke-tertiary) border-t-(--ui-accent)' }),
  ] })
}

function ErrorState({ message }) {
  return jsxs('div', { className: 'flex h-full flex-col items-center justify-center gap-2 px-4 text-center', children: [
    jsx('span', { className: 'text-sm font-medium text-(--ui-text-secondary)', children: '读取用量失败' }),
    jsx('span', { className: 'max-w-[240px] break-words text-xs text-(--ui-text-tertiary)', children: message }),
    jsx('button', { className: 'text-xs font-medium text-(--ui-accent) hover:underline', onClick: refresh, children: '重试' }),
  ] })
}

// ---- 面板 ----
function Panel() {
  const usage = useValue(host.state.focusedUsage)
  const stats = useValue($stats)
  const err = useValue($statsError)
  const sid = useValue(host.state.focusedSessionId)
  const balance = useValue($balance)
  const pricing = useValue($pricing)

  if (!sid) return jsx(Empty, {})
  if (!stats && !usage && !err) return jsx(Loading, {})
  if (err && !stats && !usage) return jsx(ErrorState, { message: err })

  const input = stats?.input_tokens ?? usage?.input ?? null   // 未缓存输入 == 未命中
  const output = stats?.output_tokens ?? usage?.output ?? null
  const hit = stats?.cache_read_tokens ?? null                // 缓存命中
  const write = stats?.cache_write_tokens ?? null             // 缓存写（DeepSeek 恒 0）
  const miss = stats ? input : null                           // 缓存未命中 = input_tokens
  const promptTotal = stats ? stats.prompt_tokens : (usage?.prompt ?? input) // 输入总量 = 总 prompt
  // 命中率 = 缓存命中 ÷ 输入总量（cache_read / prompt_tokens，与宿主 cache_hit_pct 同口径）。
  const hitRate = stats
    ? (promptTotal > 0 ? (hit ?? 0) / promptTotal : null)
    : (usage?.cache_hit_pct != null ? usage.cache_hit_pct / 100 : null)

  const costMicrosVal = costMicros(stats, pricing)
  const cost = costMicrosVal == null ? null : costMicrosVal / 1e6
  const costCurrency = pricing.currency === 'CNY' ? 'CNY' : 'USD'
  // 总量 = 输入总量 + 输出（含缓存读/写，口径自明，避免与 Hermes 的 total_tokens 计数口径混淆）。
  const total = promptTotal != null || output != null ? (promptTotal ?? 0) + (output ?? 0) : null
  const calls = stats?.api_calls ?? usage?.calls ?? null
  const tps = stats?.tokens_per_s ?? usage?.avg_tps ?? null
  const ctxUsed = usage?.context_used ?? stats?.context_length ?? null
  const ctxMax = usage?.context_max ?? stats?.config_context_length ?? null
  const ctxPct = ctxUsed != null && ctxMax ? ctxUsed / ctxMax : (usage?.context_percent != null ? usage.context_percent / 100 : null)
  const lowBalance = balance && typeof balance.amount === 'number' && balance.currency === costCurrency && cost != null && cost >= balance.amount

  return jsxs('div', { className: 'flex h-full flex-col gap-3 overflow-y-auto px-3 py-3', children: [
    // 头部：模型 / provider / 刷新
    jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
      jsxs('div', { className: 'flex min-w-0 items-center gap-1.5', children: [
        stats?.model ? jsx('span', { className: 'truncate text-xs font-medium text-(--ui-text-secondary)', children: stats.model }) : null,
        stats?.provider
          ? jsx('span', { className: 'shrink-0 rounded bg-(--ui-bg-tertiary) px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: stats.provider })
          : null,
      ] }),
      jsx('button', {
        className: 'shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:bg-(--ui-bg-tertiary) hover:text-(--ui-text-primary)',
        onClick: refresh,
        title: '刷新',
        children: '刷新',
      }),
    ] }),

    // 四路 token
    jsx('div', { className: 'grid grid-cols-2 gap-2', children: [
      jsx(StatTile, { label: '输入总量', value: fmtTokens(promptTotal), sub: tokenSub(promptTotal) }),
      jsx(StatTile, { label: '输出', value: fmtTokens(output), sub: tokenSub(output) }),
      jsx(StatTile, { label: '缓存命中', value: fmtTokens(hit), sub: tokenSub(hit), tone: 'hit' }),
      jsx(StatTile, { label: '缓存未命中', value: fmtTokens(miss), sub: tokenSub(miss) }),
    ] }),

    // 命中率
    jsxs('div', { className: 'flex flex-col gap-1.5 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-2.5 py-2', children: [
      jsxs('div', { className: 'flex items-baseline justify-between', children: [
        jsx('span', { className: 'text-[0.6875rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: '缓存命中率' }),
        jsx('span', { className: 'text-sm font-semibold tabular-nums text-(--ui-text-primary)', children: fmtPct(hitRate) }),
      ] }),
      jsx(HitBar, { rate: hitRate }),
      jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: '命中率 = 缓存命中 ÷ 输入总量，不含输出' }),
    ] }),

    // 费用 / 余额
    jsxs('div', { className: 'flex flex-col rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-2.5 py-2', children: [
      jsx(MetricRow, { label: '会话费用', value: fmtMoney(cost, costCurrency) }),
      jsx(MetricRow, { label: '余额', value: fmtBalance(balance), hint: balance ? null : '未设置' }),
      lowBalance
        ? jsx('span', { className: 'text-[0.625rem] text-(--ui-yellow)', children: '本次费用已接近或超过所设余额' })
        : null,
    ] }),

    // 汇总
    jsxs('div', { className: 'flex flex-col rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-2.5 py-2', children: [
      jsx(MetricRow, { label: '会话 token 总量', value: fmtInt(total) }),
      jsx(MetricRow, { label: 'API 调用', value: fmtInt(calls) }),
      jsx(MetricRow, { label: '生成速度', value: tps != null ? Number(tps).toFixed(1) + ' tok/s' : '—' }),
      jsx(MetricRow, {
        label: '上下文占用',
        value: ctxUsed != null ? fmtTokens(ctxUsed) + ' / ' + fmtTokens(ctxMax) : '—',
        hint: ctxPct != null ? fmtPct(ctxPct) : null,
      }),
    ] }),
  ] })
}

// ---- 设置页 ----
function SettingsPage() {
  const balance = useValue($balance)
  const draft = useValue($draftBalance)
  const currency = useValue($draftCurrency)

  const save = () => {
    const amount = parseFloat(draft)
    if (!Number.isFinite(amount) || amount < 0) return
    const next = { amount, currency: currency === 'CNY' ? 'CNY' : 'USD' }
    $balance.set(next)
    pluginCtx?.storage.set('balance', next)
  }
  const clear = () => {
    $balance.set(null)
    pluginCtx?.storage.remove('balance')
  }

  return jsxs('div', { className: 'flex max-w-xl flex-col gap-6 px-4 py-5', children: [
    jsxs('div', { className: 'flex flex-col gap-2', children: [
      jsx('div', { className: 'text-sm font-semibold text-(--ui-text-primary)', children: '余额' }),
      jsx('p', { className: 'text-xs leading-relaxed text-(--ui-text-tertiary)', children: '面板中的「余额」为手动登记值（Hermes 未提供通用余额接口），仅用于对照费用、不参与扣减。' }),
      jsxs('div', { className: 'flex items-center gap-2', children: [
        jsx('input', {
          type: 'number', min: '0', step: '0.01', inputMode: 'decimal',
          value: draft,
          placeholder: balance && typeof balance.amount === 'number' ? String(balance.amount) : '0.00',
          onChange: (e) => $draftBalance.set(e.target.value),
          className: 'h-8 w-40 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 text-sm tabular-nums text-(--ui-text-primary) outline-none focus:border-(--ui-accent)',
        }),
        jsx('select', {
          value: currency,
          onChange: (e) => $draftCurrency.set(e.target.value),
          className: 'h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-1.5 text-sm text-(--ui-text-primary) outline-none focus:border-(--ui-accent)',
          children: [
            jsx('option', { value: 'CNY', children: 'CNY' }),
            jsx('option', { value: 'USD', children: 'USD' }),
          ],
        }),
        jsx('button', {
          onClick: save,
          className: 'h-8 rounded-md bg-(--ui-accent) px-3 text-sm font-medium text-white hover:opacity-90',
          children: '保存',
        }),
        jsx('button', {
          onClick: clear,
          className: 'h-8 rounded-md border border-(--ui-stroke-secondary) px-3 text-sm text-(--ui-text-secondary) hover:bg-(--ui-bg-tertiary)',
          children: '清除',
        }),
      ] }),
    ] }),

    jsxs('div', { className: 'flex flex-col gap-2', children: [
      jsx('div', { className: 'text-sm font-semibold text-(--ui-text-primary)', children: '数据来源' }),
      jsx('p', { className: 'text-xs leading-relaxed text-(--ui-text-tertiary)', children: '输入总量 / 输出 / 缓存命中 / 缓存未命中 token 均来自 gateway 的 session.stats（每 2 秒刷新）。语义：缓存命中 = cache_read_tokens；缓存未命中 = input_tokens（未缓存输入，DeepSeek 的 prompt_cache_miss_tokens，非零）；输入总量 = prompt_tokens = 未命中 + 命中 + 缓存写，即 DeepSeek 的 prompt_tokens 总量。命中率 = 缓存命中 ÷ 输入总量（与宿主 cache_hit_pct 同口径）。' }),
      jsx('p', { className: 'text-xs leading-relaxed text-(--ui-text-tertiary)', children: '费用由本插件按四路 token × 演示价目表本地计算（flash：输入 ¥2、缓存写 ¥2、缓存读 ¥0.2、输出 ¥8 每百万 token；pro 为 ¥9/¥9/¥0.9/¥27）。非官方定价；可经插件存储 pricing 键覆盖。' }),
    ] }),
  ] })
}

// ---- 注册 ----
function register(ctx) {
  pluginCtx = ctx

  // 恢复持久化余额
  const saved = ctx.storage.get('balance', null)
  if (saved && typeof saved === 'object' && typeof saved.amount === 'number') {
    $balance.set(saved)
    $draftBalance.set(String(saved.amount))
    $draftCurrency.set(saved.currency === 'CNY' ? 'CNY' : 'USD')
  }

  // 恢复可覆盖价目表（可选；缺省用 DEMO_PRICE_BOOK）
  const savedPricing = ctx.storage.get('pricing', null)
  if (savedPricing && savedPricing.models && savedPricing.currency) {
    $pricing.set(savedPricing)
  }

  // 会话切换 -> 立即刷新
  const unsub = host.state.focusedSessionId.subscribe(() => { refresh() })
  ctx.onDispose(unsub)

  // 周期轮询（仅在有聚焦会话时）
  ctx.setInterval(() => { if (host.state.focusedSessionId.get()) refresh() }, POLL_MS)

  // 首刷
  refresh()

  ctx.register({
    id: 'panel',
    area: PANES_AREA,
    title: 'Token 消耗',
    order: 50,
    data: { placement: 'right' },
    render: () => jsx(Panel, {}),
  })

  ctx.registerSettingsPage({
    id: 'settings',
    title: 'Token 消耗',
    icon: 'flame',
    order: 50,
    render: () => jsx(SettingsPage, {}),
  })
}

export default { id: 'token-cost-panel', name: 'Token 消耗面板', register }
