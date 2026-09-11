import { describe, expect, it, vi } from 'vitest'
import { createPcm16Player } from './aarya-voice'

type MockFn = ReturnType<typeof vi.fn>

interface MockSource {
  connect: MockFn
  start: MockFn
  stop: MockFn
}

function createMockAudioContext(startTime: number) {
  const sources: MockSource[] = []

  const context = {
    currentTime: startTime,
    destination: {},
    createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      copyToChannel: vi.fn(),
    })),
    createBufferSource: vi.fn(() => {
      const source: MockSource = {
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }
      sources.push(source)
      return source
    }),
  }

  return { context, sources }
}

describe('createPcm16Player', () => {
  it('schedules chunks back-to-back without overlap', () => {
    const { context, sources } = createMockAudioContext(10)
    const player = createPcm16Player(context as unknown as AudioContext)

    // 1600 samples at 16kHz = 0.1 seconds per chunk.
    player.play(new Int16Array(1600).buffer)
    player.play(new Int16Array(1600).buffer)

    expect(sources).toHaveLength(2)
    const firstStart = sources[0].start.mock.calls[0][0] as number
    const secondStart = sources[1].start.mock.calls[0][0] as number
    expect(firstStart).toBeCloseTo(10.04, 5)
    expect(secondStart).toBeCloseTo(firstStart + 0.1, 5)
  })

  it('primes only the first chunk and keeps later chunks contiguous', () => {
    const { context, sources } = createMockAudioContext(10)
    const player = createPcm16Player(context as unknown as AudioContext)

    player.play(new Int16Array(800).buffer) // 0.05s
    player.play(new Int16Array(1600).buffer) // 0.1s
    player.play(new Int16Array(1600).buffer) // 0.1s

    const starts = sources.map((s) => s.start.mock.calls[0][0] as number)
    expect(starts[0]).toBeCloseTo(10.04, 5)
    expect(starts[1]).toBeCloseTo(starts[0] + 0.05, 5)
    expect(starts[2]).toBeCloseTo(starts[1] + 0.1, 5)
  })

  it('flush stops active sources and resets the schedule', () => {
    const { context, sources } = createMockAudioContext(10)
    const player = createPcm16Player(context as unknown as AudioContext)

    player.play(new Int16Array(1600).buffer)
    player.flush()

    expect(sources[0].stop).toHaveBeenCalledTimes(1)

    player.play(new Int16Array(1600).buffer)
    const restarted = sources[1].start.mock.calls[0][0] as number
    expect(restarted).toBeCloseTo(10.04, 5)
  })

  it('ignores empty chunks', () => {
    const { context, sources } = createMockAudioContext(10)
    const player = createPcm16Player(context as unknown as AudioContext)

    player.play(new Int16Array(0).buffer)

    expect(sources).toHaveLength(0)
  })
})
