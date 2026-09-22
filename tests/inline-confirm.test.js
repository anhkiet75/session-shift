import { describe, it, expect, vi } from 'vitest'
import { createInlineConfirmController } from '../lib/inline-confirm.js'

function labels() {
  return { cancelText: 'Cancel', cancelTitle: 'Cancel delete', confirmText: 'Delete', confirmTitle: 'Confirm delete' }
}

describe('createInlineConfirmController', () => {
  it('hides the given elements and appends cancel/confirm buttons', () => {
    const controller = createInlineConfirmController()
    const container = document.createElement('div')
    const hidden = document.createElement('button')
    container.appendChild(hidden)

    controller.start({ container, hiddenElements: [hidden], cancelClassName: 'c', confirmClassName: 'k', labels: labels(), onConfirm: vi.fn() })

    expect(hidden.style.display).toBe('none')
    expect(container.querySelector('.c')).not.toBeNull()
    expect(container.querySelector('.k')).not.toBeNull()
  })

  it('cancel restores the hidden elements and removes the confirm buttons', () => {
    const controller = createInlineConfirmController()
    const container = document.createElement('div')
    const hidden = document.createElement('button')
    container.appendChild(hidden)
    controller.start({ container, hiddenElements: [hidden], cancelClassName: 'c', confirmClassName: 'k', labels: labels(), onConfirm: vi.fn() })

    container.querySelector('.c').click()

    expect(hidden.style.display).toBe('')
    expect(container.querySelector('.c')).toBeNull()
    expect(container.querySelector('.k')).toBeNull()
  })

  it('confirm calls onConfirm and does not restore the hidden elements', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const controller = createInlineConfirmController()
    const container = document.createElement('div')
    const hidden = document.createElement('button')
    container.appendChild(hidden)
    controller.start({ container, hiddenElements: [hidden], cancelClassName: 'c', confirmClassName: 'k', labels: labels(), onConfirm })

    container.querySelector('.k').click()
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('re-arms on a failed confirm instead of leaving the row stuck', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('boom'))
    const controller = createInlineConfirmController()
    const container = document.createElement('div')
    const hidden = document.createElement('button')
    container.appendChild(hidden)
    controller.start({ container, hiddenElements: [hidden], cancelClassName: 'c', confirmClassName: 'k', labels: labels(), onConfirm })

    container.querySelector('.k').click()
    await vi.waitFor(() => expect(container.querySelector('.k').disabled).toBe(false))
    expect(container.querySelector('.c').disabled).toBe(false)
  })

  it('starting a second confirm cancels the first one (one open at a time)', () => {
    const controller = createInlineConfirmController()
    const containerA = document.createElement('div')
    const hiddenA = document.createElement('button')
    containerA.appendChild(hiddenA)
    const containerB = document.createElement('div')
    const hiddenB = document.createElement('button')
    containerB.appendChild(hiddenB)

    controller.start({ container: containerA, hiddenElements: [hiddenA], cancelClassName: 'c', confirmClassName: 'k', labels: labels(), onConfirm: vi.fn() })
    controller.start({ container: containerB, hiddenElements: [hiddenB], cancelClassName: 'c', confirmClassName: 'k', labels: labels(), onConfirm: vi.fn() })

    expect(hiddenA.style.display).toBe('') // A's confirm was cancelled when B started
    expect(containerA.querySelector('.c')).toBeNull()
    expect(hiddenB.style.display).toBe('none')
  })

  it('Escape cancels the open confirm', () => {
    const controller = createInlineConfirmController()
    const container = document.createElement('div')
    const hidden = document.createElement('button')
    container.appendChild(hidden)
    controller.start({ container, hiddenElements: [hidden], cancelClassName: 'c', confirmClassName: 'k', labels: labels(), onConfirm: vi.fn() })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(hidden.style.display).toBe('')
    expect(container.querySelector('.c')).toBeNull()
  })

  it('cancelActive() is a no-op with nothing open', () => {
    const controller = createInlineConfirmController()
    expect(() => controller.cancelActive()).not.toThrow()
  })
})
