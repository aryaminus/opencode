import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import type {
  ClipboardOptions,
  ClipboardService,
  HostClipboardOptions,
  HostClipboardService,
  RendererClipboardBoundary,
} from "@opentui/core"
import { Effect, Logger } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
import type { TuiInput } from "../src/app"

const openTui = { ...(await import("@opentui/core")) }

function restoreOpenTui() {
  mock.restore()
  mock.module("@opentui/core", () => openTui)
}

async function mockOpenTuiClipboard(
  renderer: RendererClipboardBoundary,
  options: {
    dispose?: () => Promise<void>
    constructionError?: Error
  } = {},
) {
  const calls = {
    host: [] as (HostClipboardOptions | undefined)[],
    adapter: [] as RendererClipboardBoundary[],
    service: [] as ClipboardOptions[],
    dispose: 0,
    hostDispose: 0,
    hostWrite: 0,
  }
  const host: HostClipboardService = {
    maxWriteBytes: 8 * 1024 * 1024,
    async read() {
      return { status: "empty" }
    },
    async writeText() {
      calls.hostWrite++
      return { status: "written" }
    },
    async clear() {
      return { status: "cleared" }
    },
    async dispose() {
      calls.hostDispose++
      await options.dispose?.()
    },
  }

  mock.module("@opentui/core", () => ({
    ...openTui,
    createCliRenderer: async () => renderer,
    createHostClipboard: (input?: HostClipboardOptions) => {
      if (options.constructionError) throw options.constructionError
      calls.host.push(input)
      return host
    },
    createRendererClipboardAdapter: (input: RendererClipboardBoundary) => {
      calls.adapter.push(input)
      return openTui.createRendererClipboardAdapter(input)
    },
    createClipboard: (input: ClipboardOptions) => {
      calls.service.push(input)
      const service = openTui.createClipboard(input)
      return {
        read: service.read,
        writeText: service.writeText,
        clear: service.clear,
        async dispose() {
          calls.dispose++
          await service.dispose()
        },
      } satisfies ClipboardService
    },
  }))
  return calls
}

async function launch(
  calls: ReturnType<typeof createFetch>,
  options: {
    args?: TuiInput["args"]
    onStart?: (api: TuiPluginApi) => void
    onDispose?: () => void | Promise<void>
    logs?: unknown[]
  } = {},
) {
  const { run } = await import("../src/app")
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const effect = run({
    url: "http://test",
    directory,
    config: createTuiResolvedConfig({ plugin_enabled: {} }),
    fetch: calls.fetch,
    events: createEventSource().source,
    args: options.args ?? {},
    pluginHost: {
      async start(input) {
        options.onStart?.(input.api)
        started()
      },
      async dispose() {
        await options.onDispose?.()
      },
    },
  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
  const task = Effect.runPromise(
    options.logs
      ? effect.pipe(
          Effect.provide(Logger.layer([Logger.make(({ message }) => void options.logs?.push(message))])),
        )
      : effect,
  )
  await ready
  return { task }
}

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const clipboard = await mockOpenTuiClipboard(setup.renderer)
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = process.listeners("SIGHUP")
  const calls = createFetch()
  let disposes = 0

  try {
    const { task } = await launch(calls, { onDispose: () => void disposes++ })
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(clipboard.host).toEqual([
      {
        timeoutMs: 1_000,
        maxReadBytes: 8 * 1024 * 1024,
        maxWriteBytes: 8 * 1024 * 1024,
        maxImagePixels: 64 * 1024 * 1024,
        maxConversionBytes: 512 * 1024 * 1024,
        maxConcurrentOperations: 16,
        maxProviderTransfers: 16,
        maxWorkUnitsPerDrain: 64,
      },
    ])
    expect(clipboard.adapter).toEqual([setup.renderer])
    expect(clipboard.service).toHaveLength(1)
    expect(clipboard.dispose).toBe(1)
    expect(clipboard.hostDispose).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.includes(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    restoreOpenTui()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  let releaseDispose!: () => void
  let startDispose!: () => void
  const disposeStarted = new Promise<void>((resolve) => {
    startDispose = resolve
  })
  const disposeReady = new Promise<void>((resolve) => {
    releaseDispose = resolve
  })
  const clipboard = await mockOpenTuiClipboard(setup.renderer, {
    dispose: async () => {
      startDispose()
      await disposeReady
    },
  })
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { task } = await launch(calls, { args: { continue: true }, onStart: (value) => (api = value) })
    let settled = false
    void task.then(
      () => (settled = true),
      () => (settled = true),
    )
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await disposeStarted
    expect(settled).toBe(false)
    expect(stdout).not.toContain("Demo session")
    releaseDispose()
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
    expect(clipboard.dispose).toBe(1)
    expect(clipboard.hostDispose).toBe(1)
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    restoreOpenTui()
  }
})

test("direct renderer destruction disposes the clipboard once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const clipboard = await mockOpenTuiClipboard(setup.renderer)
  const calls = createFetch()

  try {
    const { task } = await launch(calls)
    const staleCopy = setup.renderer.console.onCopySelection
    setup.renderer.destroy()
    await task
    expect(clipboard.dispose).toBe(1)
    expect(clipboard.hostDispose).toBe(1)
    await staleCopy?.("stale")
    expect(clipboard.hostWrite).toBe(0)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    restoreOpenTui()
  }
})

test("clipboard construction failure releases the renderer", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const failure = new Error("clipboard construction failed")
  await mockOpenTuiClipboard(setup.renderer, { constructionError: failure })
  const calls = createFetch()

  try {
    const { run } = await import("../src/app")
    await expect(
      Effect.runPromise(
        run({
          url: "http://test",
          directory,
          config: createTuiResolvedConfig({ plugin_enabled: {} }),
          fetch: calls.fetch,
          events: createEventSource().source,
          args: {},
          pluginHost: { async start() {}, async dispose() {} },
        }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
      ),
    ).rejects.toThrow("clipboard construction failed")
    expect(setup.renderer.isDestroyed).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    restoreOpenTui()
  }
})

test("clipboard disposal failure is logged without failing remaining cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const clipboard = await mockOpenTuiClipboard(setup.renderer, {
    dispose: async () => {
      throw new Error("clipboard disposal failed")
    },
  })
  const calls = createFetch()
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  let pluginDisposes = 0
  const logs: unknown[] = []

  try {
    const { task } = await launch(calls, { logs, onDispose: () => void pluginDisposes++ })
    setup.renderer.destroy()
    await task
    expect(clipboard.dispose).toBe(1)
    expect(clipboard.hostDispose).toBe(1)
    expect(pluginDisposes).toBe(1)
    expect(titles.at(-1)).toBe("")
    expect(setup.renderer.isDestroyed).toBe(true)
    expect(
      logs.some((message) =>
        (Array.isArray(message) ? message : [message]).some((value) => value === "Failed to dispose TUI clipboard"),
      ),
    ).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    restoreOpenTui()
  }
})
