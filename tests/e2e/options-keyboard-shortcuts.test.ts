import { test, expect } from './extension-fixtures'

// Every command ships unbound: a default Ctrl/Cmd+Shift+Left/Right binding
// hijacked OS text selection and silently moved the active tab to another
// profile, and Ctrl/Cmd+Shift+S shadowed Save As. These specs pin the
// fresh-install contract and the Options surface that lets users bind their
// own keys.
//
// Not covered here: pressing the chord in a page. Playwright dispatches keys
// through CDP straight to the renderer, bypassing the browser-level
// accelerator table where extension commands live, so such a test would pass
// whether or not a binding exists. The manifest unit guard plus the
// `chrome.commands.getAll()` assertion below are the meaningful checks.

test.describe('Options → Keyboard shortcuts', () => {
  test('every command is unbound on a fresh install', async ({ context, optionsUrl }) => {
    const options = await context.newPage()
    await options.goto(optionsUrl)

    const bindings = await options.evaluate(async () => {
      const commands = await chrome.commands.getAll()
      return Object.fromEntries(commands.map(c => [c.name, c.shortcut]))
    })
    expect(bindings).toEqual({ '_execute_action': '', 'session-next': '', 'session-prev': '' })

    await options.close()
  })

  test('lists each command, showing "Not set" when unbound', async ({ context, optionsUrl }) => {
    const options = await context.newPage()
    await options.goto(optionsUrl)

    await expect(options.locator('.opt-shortcut-row')).toHaveCount(3)
    for (const name of ['_execute_action', 'session-next', 'session-prev']) {
      const key = options.locator(`kbd[data-command="${name}"]`)
      await expect(key).toHaveText('Not set')
      await expect(key).toHaveClass(/opt-shortcut-key-unset/)
    }

    await options.close()
  })

  test('re-renders the rows in the chosen language', async ({ context, optionsUrl }) => {
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.waitForSelector('#languageSelect')

    await options.selectOption('#languageSelect', 'de')
    await expect(options.locator('kbd[data-command="session-next"]')).toHaveText('Nicht festgelegt')
    await expect(options.locator('#openShortcutsBtn')).toHaveText('Tastenkombinationen ändern')

    await options.close()
  })

  test('"Change shortcuts" opens Chrome\'s shortcut editor', async ({ context, optionsUrl }) => {
    const options = await context.newPage()
    await options.goto(optionsUrl)

    const [editor] = await Promise.all([
      context.waitForEvent('page'),
      options.locator('#openShortcutsBtn').click(),
    ])
    await expect.poll(() => editor.url()).toMatch(/^chrome:\/\/extensions\/shortcuts/)

    await options.close()
  })
})
