import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { setTimeout } from 'node:timers/promises'

// 自動化シグナル(navigator.webdriver 等)を隠し、Cloudflare Turnstile の検知を緩和する
puppeteer.use(StealthPlugin())

const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
if (process.env.PROXY_SERVER) {
    const proxy_url = new URL(process.env.PROXY_SERVER)
    proxy_url.username = ''
    proxy_url.password = ''
    args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''))
}

// 画面上にモーダルが表示されていれば閉じる（出なければ何もしない）
async function closeModalIfPresent(page) {
    const modalClose = await page.waitForSelector('button.modal__close', { timeout: 5000 }).catch(() => null)
    if (modalClose) {
        await modalClose.click()
    }
}

const browser = await puppeteer.launch({
    // ヘッドフルで起動する（ヘッドレスはTurnstileに検知されやすいため、CIではxvfb上で実行する）
    headless: false,
    defaultViewport: { width: 1080, height: 1024 },
    args,
})
const [page] = await browser.pages()
const userAgent = await browser.userAgent()
await page.setUserAgent(userAgent.replace('Headless', ''))
const recorder = await page.screencast({ path: 'recording.webm' })

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER)
        if (username && password) {
            await page.authenticate({ username, password })
        }
    }

    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await page.locator('text=ログインする').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    // ログイン後にモーダルが表示される場合は閉じる
    await closeModalIfPresent(page)
    // 詳細リンクのURLから無料VPS継続ページを組み立てて直接遷移する
    // （UI変更で「更新する」ボタンの位置が変わり、画面操作では遷移できないため）
    const detailHref = await page.$eval('a[href^="/xapanel/xvps/server/detail?id="]', a => a.href)
    await page.goto(detailHref.replace('detail?id', 'freevps/extend/index?id_vps'), { waitUntil: 'networkidle2' })
    // 継続ページでもモーダルが表示される場合があるため閉じる
    await closeModalIfPresent(page)
    await page.locator('text=引き続き無料VPSの利用を継続する').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    const body = await page.$eval('img[src^="data:"]', img => img.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body }).then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
    // Cloudflare Turnstile: チェックボックスをクリックし、トークンが生成されるまで待つ
    const turnstile = await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { timeout: 15000 }).catch(() => null)
    if (turnstile) {
        await turnstile.scrollIntoView()
        await setTimeout(3000) // ウィジェット内のチェックボックス描画を待つ

        // まずTurnstileのiframe内のチェックボックス要素を直接クリックする（座標推測を避ける）
        let clicked = false
        const cfFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'))
        if (cfFrame) {
            const checkbox = await cfFrame.waitForSelector('input[type="checkbox"]', { timeout: 5000 }).catch(() => null)
            if (checkbox) {
                await checkbox.click()
                clicked = true
            }
        }

        // 要素が取得できない場合は座標でクリック（チェックボックスは左側・縦中央付近）
        if (!clicked) {
            const box = await turnstile.boundingBox()
            if (box) {
                const x = box.x + 22
                const y = box.y + box.height / 2
                await page.mouse.move(x, y, { steps: 10 }) // 人間らしいマウス移動
                await setTimeout(500)
                await page.mouse.click(x, y)
            }
        }

        // cf-turnstile-response にトークンがセットされるまで待つ（生成されない場合もそのまま進む）
        await page.waitForFunction(
            () => document.querySelector('[name="cf-turnstile-response"]')?.value,
            { timeout: 30000 }
        ).catch(() => null)
    }
    await page.locator('text=無料VPSの利用を継続する').click()
} catch (e) {
    console.error(e)
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
