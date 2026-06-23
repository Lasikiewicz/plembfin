import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 500, height: 717 });
  await page.goto('http://127.0.0.1:5055/tvshow/sullivan-s-crossing#season4');
  
  // Wait for page to render
  await page.waitForTimeout(2000);
  
  const results = await page.evaluate(() => {
    const el = document.getElementById('mediaDetailActions');
    if (!el) return 'Element #mediaDetailActions not found';
    
    const style = window.getComputedStyle(el);
    const rules = [];
    
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText && rule.selectorText.includes('mediaDetailActions')) {
            rules.push({ media: rule.media?.mediaText || 'none', selector: rule.selectorText, css: rule.cssText });
          } else if (rule.media) {
            for (const subRule of rule.cssRules) {
              if (subRule.selectorText && subRule.selectorText.includes('mediaDetailActions')) {
                rules.push({ media: rule.media.mediaText, selector: subRule.selectorText, css: subRule.cssText });
              }
            }
          }
        }
      } catch (e) {}
    }
    
    return {
      innerWidth: window.innerWidth,
      matches640: window.matchMedia('(max-width: 640px)').matches,
      computed: {
        display: style.display,
        flexDirection: style.flexDirection,
        flexWrap: style.flexWrap,
        overflowX: style.overflowX,
        paddingBottom: style.paddingBottom
      },
      rules
    };
  });
  
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
})();
