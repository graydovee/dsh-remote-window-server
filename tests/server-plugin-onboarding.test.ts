import { describe, expect, it, vi } from 'vitest'
import { dismissOnboarding } from '../src/server-plugin/onboarding.ts'

class FakeButton {
  clicked = 0
  constructor(public textContent: string, public disabled = false) {}
  click(): void { this.clicked += 1 }
}

class FakeDialog {
  constructor(private readonly buttons: FakeButton[]) {}
  querySelectorAll(selector: string): FakeButton[] {
    return selector.includes('button') ? this.buttons : []
  }
}

class FakeRoot {
  constructor(private readonly dialogs: FakeDialog[], private readonly looseButtons: FakeButton[] = []) {}
  querySelectorAll(selector: string): FakeDialog[] | FakeButton[] {
    return selector.includes('dialog') || selector.includes('aria-modal') ? this.dialogs : this.looseButtons
  }
}

describe('embedded onboarding dismissal', () => {
  it('clicks 继续 inside a dialog', () => {
    const button = new FakeButton(' 继续 ')
    expect(dismissOnboarding(new FakeRoot([new FakeDialog([new FakeButton('取消'), button])]) as never)).toBe(true)
    expect(button.clicked).toBe(1)
  })

  it('accepts English Continue case-insensitively', () => {
    const button = new FakeButton('Continue')
    expect(dismissOnboarding(new FakeRoot([new FakeDialog([button])]) as never)).toBe(true)
    expect(button.clicked).toBe(1)
  })

  it('never clicks buttons outside dialogs or other labels', () => {
    const loose = new FakeButton('继续')
    const other = new FakeButton('保存')
    const disabled = new FakeButton('继续', true)
    expect(dismissOnboarding(new FakeRoot([], [loose]) as never)).toBe(false)
    expect(loose.clicked).toBe(0)
    expect(dismissOnboarding(new FakeRoot([new FakeDialog([other, disabled])]) as never)).toBe(false)
    expect(other.clicked).toBe(0)
    expect(disabled.clicked).toBe(0)
  })

  it('clicks only once across repeated polling', () => {
    const button = new FakeButton('继续')
    const root = new FakeRoot([new FakeDialog([button])])
    expect(dismissOnboarding(root as never)).toBe(true)
    expect(dismissOnboarding(root as never)).toBe(true)
    expect(button.clicked).toBe(2)
  })
})
