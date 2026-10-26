/**
 * One-shot dismissal of the official preview/onboarding modal inside an
 * embedded profile UI (protocol §9.3/§16.2).
 *
 * Only a button whose exact visible label is 继续/Continue inside a
 * dialog/overlay is clicked; the function never scans arbitrary page buttons
 * and never runs for a directly opened profile page (the bootstrap gates it on
 * `dshRwSession`).
 */

interface ClickableLike {
  readonly textContent?: string | null
  readonly disabled?: boolean
  click?(): void
}

interface DialogLike {
  querySelectorAll(selector: string): ArrayLike<ClickableLike>
}

interface RootLike {
  querySelectorAll(selector: string): ArrayLike<DialogLike>
}

/**
 * Click the first enabled 继续/Continue button inside a dialog/overlay.
 * @param root - document-like root queried for dialog containers.
 * @returns true when one button was clicked; false when no eligible button exists.
 */
export function dismissOnboarding(root: RootLike): boolean {
  const dialogs = root.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')
  for (let index = 0; index < dialogs.length; index++) {
    const dialog = dialogs[index]
    if (dialog === undefined) continue
    const buttons = dialog.querySelectorAll('button, [role="button"]')
    for (let buttonIndex = 0; buttonIndex < buttons.length; buttonIndex++) {
      const button = buttons[buttonIndex]
      if (button === undefined || button.disabled === true) continue
      const label = (button.textContent ?? '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
      if (label !== '继续' && label !== 'continue') continue
      if (typeof button.click !== 'function') continue
      button.click()
      return true
    }
  }
  return false
}
