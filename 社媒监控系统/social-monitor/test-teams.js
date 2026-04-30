const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto('https://teams.microsoft.com', { waitUntil: 'commit', timeout: 30000 });
    await page.waitForTimeout(10000); // wait 10s for redirects
    await page.screenshot({ path: 'teams-redirect.png' });
    console.log('Current URL:', page.url());
    console.log('Title:', await page.title());
  } catch (e) {
    console.error(e);
  }
  await browser.close();
})();
