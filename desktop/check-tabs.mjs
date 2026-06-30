const pwPath = '/Users/banxia/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs'
const { chromium } = await import(pwPath)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })

try {
  await page.goto('http://127.0.0.1:5273/', { waitUntil: 'networkidle', timeout: 15000 })
  await page.waitForTimeout(3000)

  const info = await page.evaluate(() => {
    const lists = Array.from(document.querySelectorAll('[data-slot="tabs-list"]'))
    return lists.map((el, i) => ({
      index: i,
      text: el.textContent?.slice(0, 120),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      className: el.className,
      computed: {
        display: getComputedStyle(el).display,
        overflowX: getComputedStyle(el).overflowX,
        flex: getComputedStyle(el).flex,
        width: getComputedStyle(el).width,
      },
      triggers: Array.from(el.querySelectorAll('[data-slot="tabs-trigger"]')).map(t => ({
        text: t.textContent?.slice(0, 30),
        flex: getComputedStyle(t).flex,
        flexShrink: getComputedStyle(t).flexShrink,
        flexGrow: getComputedStyle(t).flexGrow,
        width: getComputedStyle(t).width,
      }))
    }))
  })

  console.log('tabs lists:', JSON.stringify(info, null, 2))

  const btns = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.tabs-scroll-btn')).map(b => ({
      className: b.className,
      text: b.textContent,
      display: getComputedStyle(b).display,
      visibility: getComputedStyle(b).visibility,
      opacity: getComputedStyle(b).opacity,
    }))
  })
  console.log('scroll buttons:', JSON.stringify(btns, null, 2))
} catch (e) {
  console.error(e)
} finally {
  await browser.close()
}
