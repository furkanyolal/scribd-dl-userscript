// ==UserScript==
// @name         Scribd Downloader (Searchable PDF)
// @namespace    https://github.com/furkanyolal/scribd-dl-userscript
// @version      1.1.1
// @description  Adds a Download PDF button with a progress bar to Scribd document pages. Builds a searchable PDF directly in the browser from the page's own OCR'd content — for documents you're authorized to download.
// @author       furkanyolal
// @match        https://www.scribd.com/document/*
// @match        https://www.scribd.com/doc/*
// @match        https://www.scribd.com/presentation/*
// @match        https://www.scribd.com/embeds/*
// @require      https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js
// @require      https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/furkanyolal/scribd-dl-userscript/main/scribd-dl.user.js
// @updateURL    https://raw.githubusercontent.com/furkanyolal/scribd-dl-userscript/main/scribd-dl.user.js
// @supportURL   https://github.com/furkanyolal/scribd-dl-userscript/issues
// @homepageURL  https://github.com/furkanyolal/scribd-dl-userscript
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const FONT_URL = 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf';
    const IMAGE_CONCURRENCY = 12;

    /**
     * Wait for Scribd's own docManager to finish initializing
     */
    function waitForDocManager(timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const tick = () => {
                const dm = window.docManager;
                if (dm && dm.pages && Object.keys(dm.pages).length) return resolve(dm);
                if (Date.now() > deadline) return reject(new Error('Could not find a Scribd document viewer on this page.'));
                setTimeout(tick, 200);
            };
            tick();
        });
    }

    /**
     * Scribd's own page-content JSONP response looks like:
     *   window.page123_callback(["<div class=\"newpage\" ...>...</div>"]);
     * Parse out the HTML string without executing it as a script.
     */
    function parsePageJsonp(text) {
        const m = text.match(/^window\.page\d+_callback\((\[[\s\S]*\])\);?\s*$/);
        if (!m) return null;
        try {
            return JSON.parse(m[1])[0];
        } catch {
            return null;
        }
    }

    /**
     * The text layer's inline left/top/font-size style values are in a fixed
     * virtual coordinate space, unrelated to the page's actual rendered
     * size or zoom. Converting them to true document-pixel coordinates is a
     * single constant multiplier — measured as exactly 0.2 across multiple
     * sessions with very different zoom levels (0.77x, 1.51x, 1.68x), so it
     * isn't zoom-dependent. Still, rather than trust a hardcoded constant
     * forever, calibrate it from any already-loaded page when one's
     * available (Scribd always preloads the first couple of pages itself),
     * falling back to the observed constant otherwise.
     */
    function deriveTextScale(dm) {
        const pageCount = Object.keys(dm.pages).length;
        for (let n = 1; n <= pageCount; n++) {
            const p = dm.pages[n];
            if (!p?.innerPageElem || !p.origWidth) continue;
            const dom = document.getElementById('outer_page_' + n);
            const newpage = dom?.querySelector('.newpage');
            const span = newpage?.querySelector('.text_layer [class^="ff"] span.a');
            const inlineLeft = span ? parseFloat(span.style.left) || 0 : 0;
            if (!newpage || !span || !inlineLeft) continue;
            const npRect = newpage.getBoundingClientRect();
            const rect = span.getBoundingClientRect();
            const outerScale = dm._renderedPageWidth
                ? dm._renderedPageWidth / p.origWidth
                : npRect.width / p.origWidth;
            const scale = (rect.left - npRect.left) / inlineLeft / outerScale;
            if (scale > 0 && isFinite(scale)) return scale;
        }
        return 0.2;
    }

    /**
     * Fetch every page's content directly and extract its image URL, true
     * dimensions, and OCR'd text runs — without ever inserting anything
     * into the live page.
     *
     * Scribd's own per-page loader (`page.load()`) fetches content via a
     * <script> tag pointing at a JSONP endpoint, then renders it straight
     * into the live DOM. We tried mirroring that (fetch ourselves, but
     * still insert via Scribd's `_setContainerContents()` for correct
     * layout) and it looked fast in an isolated test — but at full scale,
     * back-to-back with no gap, DOM insertion cost escalates badly as more
     * of the page fills in (89ms → 1.3s → 5.5s → 16s per batch of 40,
     * confirmed independent of tab focus/throttling). The real fix is
     * avoiding DOM insertion entirely: parse each page's fetched HTML with
     * a detached DOMParser (no live layout at all), read the `orig`
     * attribute and each text span's inline style values directly, and
     * convert to true coordinates with the fixed scale factor above. No
     * loadFonts(), no _setContainerContents(), no escalating cost — this
     * measured ~2s for ~576 pages regardless of how many ran before it.
     *
     * Falls back to the native .load() + live-DOM-read path if Scribd's
     * internal API shape ever changes underneath us.
     */
    async function collectAllPagesFast(dm, onProgress) {
        const pageCount = Object.keys(dm.pages).length;
        const canFastLoad = typeof dm._appendToken === 'function'
            && typeof dm.subImageSrc === 'function';
        if (!canFastLoad) return null;

        const textScale = deriveTextScale(dm);
        const pages = new Array(pageCount);
        const CONCURRENCY = 24;
        let idx = 1;
        let completed = 0;

        const collectOne = async (n, attempts = 3) => {
            const p = dm.pages[n];
            let html = null;
            for (let a = 0; a < attempts && !html; a++) {
                try {
                    const resp = await fetch(dm._appendToken(p.contentUrl));
                    html = parsePageJsonp(await resp.text());
                } catch {
                    // retry below
                }
                if (!html) await new Promise((r) => setTimeout(r, 300 * (a + 1)));
            }
            if (!html) {
                pages[n - 1] = { src: null, width: p.origWidth, height: p.origHeight, runs: [] };
                return;
            }
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const img = doc.querySelector('img.absimg');
            const origAttr = img ? img.getAttribute('orig') : null;
            const runs = [];
            doc.querySelectorAll('.text_layer [class^="ff"]').forEach((div) => {
                const fontSizePx = parseFloat(div.style.fontSize) || 0;
                div.querySelectorAll('span.a').forEach((span) => {
                    const text = span.textContent.replace(/\s+/g, ' ');
                    if (!text.trim()) return;
                    const inlineLeft = parseFloat(span.style.left) || 0;
                    const inlineTop = parseFloat(span.style.top) || 0;
                    runs.push({
                        text,
                        x: inlineLeft * textScale,
                        y: inlineTop * textScale,
                        fontSize: fontSizePx * textScale,
                    });
                });
            });
            pages[n - 1] = {
                src: origAttr ? dm.subImageSrc(origAttr) : null,
                width: p.origWidth,
                height: p.origHeight,
                runs,
            };
        };
        const worker = async () => {
            while (idx <= pageCount) {
                await collectOne(idx++);
                completed++;
                onProgress?.('Loading page content...', completed, pageCount);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pageCount) }, worker));
        return pages;
    }

    /**
     * Fallback path: Scribd's own <script>-tag content loader plus a
     * live-DOM read via getBoundingClientRect(). Slower, but only used if
     * the internal APIs collectAllPagesFast relies on ever disappear.
     */
    async function collectAllPagesSlow(dm, onProgress) {
        const pageCount = Object.keys(dm.pages).length;
        const waitUntil = (cond, timeoutMs) => new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const tick = () => {
                if (cond() || Date.now() > deadline) return resolve(cond());
                setTimeout(tick, 100);
            };
            tick();
        });
        for (let n = 1; n <= pageCount; n++) {
            const p = dm.pages[n];
            if (p && !p.innerPageElem && !p.loadHasStarted) p.load();
        }
        await waitUntil(() => {
            let loaded = 0;
            for (let n = 1; n <= pageCount; n++) if (dm.pages[n]?.innerPageElem) loaded++;
            onProgress?.('Loading page content...', loaded, pageCount);
            return loaded === pageCount;
        }, 60000);

        const pages = [];
        document.querySelectorAll("div.outer_page_container div[id^='outer_page_']").forEach((dom) => {
            const match = dom.id.match(/outer_page_(\d+)/);
            const pageNum = match ? parseInt(match[1], 10) : null;
            const dp = dm.pages?.[pageNum];
            const img = dom.querySelector('img.absimg');
            const newpage = dom.querySelector('.newpage');
            const npRect = newpage ? newpage.getBoundingClientRect() : null;
            const outerScale = (npRect && dp?.origWidth) ? (npRect.width / dp.origWidth) : 1;

            const runs = [];
            if (newpage) {
                newpage.querySelectorAll('.text_layer [class^="ff"]').forEach((div) => {
                    const fontSizePx = parseFloat(div.style.fontSize) || 0;
                    div.querySelectorAll('span.a').forEach((span) => {
                        const text = span.textContent.replace(/\s+/g, ' ');
                        if (!text.trim()) return;
                        const rect = span.getBoundingClientRect();
                        const inlineLeft = parseFloat(span.style.left) || 0;
                        const combinedScale = inlineLeft > 0
                            ? (rect.left - npRect.left) / inlineLeft
                            : outerScale * 0.2;
                        runs.push({
                            text,
                            x: (rect.left - npRect.left) / outerScale,
                            y: (rect.top - npRect.top) / outerScale,
                            fontSize: fontSizePx * combinedScale / outerScale,
                        });
                    });
                });
            }

            const origAttr = img ? img.getAttribute('orig') : null;
            pages.push({
                src: origAttr ? dm.subImageSrc(origAttr) : null,
                width: dp ? dp.origWidth : null,
                height: dp ? dp.origHeight : null,
                runs,
            });
        });
        return pages;
    }

    /**
     * Fetch a single page image, retrying on transient failures or responses
     * that fail a basic JPEG structure check (bad SOI/EOI markers)
     */
    async function fetchImage(src, attempts = 6) {
        for (let a = 0; a < attempts; a++) {
            try {
                const resp = await fetch(src);
                if (resp.ok) {
                    const buf = new Uint8Array(await resp.arrayBuffer());
                    const isValidJpeg = buf.length > 4
                        && buf[0] === 0xFF && buf[1] === 0xD8
                        && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;
                    if (isValidJpeg) return buf;
                }
            } catch {
                // retry below
            }
            await new Promise((r) => setTimeout(r, 500 * Math.pow(1.6, a)));
        }
        return null;
    }

    async function downloadAllImages(pages, onProgress) {
        const buffers = new Array(pages.length);
        let idx = 0;
        let completed = 0;
        const worker = async () => {
            while (idx < pages.length) {
                const i = idx++;
                buffers[i] = pages[i].src ? await fetchImage(pages[i].src) : null;
                completed++;
                onProgress?.('Downloading page images...', completed, pages.length);
            }
        };
        await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, pages.length) }, worker));
        return buffers;
    }

    let fontBytesCache = null;
    async function loadUnicodeFont() {
        if (fontBytesCache) return fontBytesCache;
        const resp = await fetch(FONT_URL);
        fontBytesCache = await resp.arrayBuffer();
        return fontBytesCache;
    }

    /**
     * Build a PDF with an invisible, searchable text layer overlaid on top of
     * each page's source scan image
     */
    async function buildSearchablePdf(pages, images, onProgress) {
        onProgress?.('Preparing PDF...', 0, 0);
        const { PDFDocument, rgb } = PDFLib;
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);

        onProgress?.('Loading font...', 0, 0);
        const fontBytes = await loadUnicodeFont();
        const font = await pdfDoc.embedFont(fontBytes, { subset: true });

        onProgress?.('Building PDF...', 0, pages.length);
        for (let i = 0; i < pages.length; i++) {
            const { width, height, runs } = pages[i];
            const page = pdfDoc.addPage([width, height]);

            let bytes = images[i];
            let embedded = false;
            for (let attempt = 0; bytes && !embedded && attempt < 4; attempt++) {
                try {
                    const embedImage = await pdfDoc.embedJpg(bytes);
                    page.drawImage(embedImage, { x: 0, y: 0, width, height });
                    embedded = true;
                } catch {
                    bytes = pages[i].src ? await fetchImage(pages[i].src) : null;
                }
            }

            for (const run of runs) {
                const size = Math.max(1, run.fontSize);
                try {
                    page.drawText(run.text, {
                        x: run.x,
                        y: height - run.y - size,
                        size,
                        font,
                        color: rgb(0, 0, 0),
                        opacity: 0,
                    });
                } catch {
                    // skip glyphs the font can't render rather than failing the whole page
                }
            }

            onProgress?.('Building PDF...', i + 1, pages.length);
        }

        return pdfDoc.save();
    }

    function getDocumentTitle() {
        const h1 = document.querySelector('h1');
        if (h1?.textContent?.trim()) return h1.textContent.trim();
        return document.title.replace(/\s*\|\s*PDF$/i, '').trim() || 'document';
    }

    function sanitizeFilename(name) {
        return name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
    }

    function triggerDownload(bytes, filename) {
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    // --- UI ---

    // Progress is driven by discrete events (one per page/image/etc.), so
    // there are brief stretches — e.g. waiting on the last few concurrent
    // downloads in a batch, one of which needed a retry — where the counter
    // doesn't move for a couple seconds even though work is still happening.
    // A subtle pulse keeps the bar visibly "alive" through those gaps
    // instead of looking frozen.
    const style = document.createElement('style');
    style.textContent = `
        @keyframes scribd-dl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    `;
    document.head.appendChild(style);

    const ui = document.createElement('div');
    ui.style.cssText = `
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    const panel = document.createElement('div');
    panel.style.cssText = `
        background: #1a1a1a; color: #fff; border-radius: 10px; padding: 12px 16px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3); min-width: 220px;
    `;
    const button = document.createElement('button');
    button.textContent = '⬇ Download PDF';
    button.style.cssText = `
        background: #2b6cb0; color: #fff; border: none; border-radius: 6px;
        padding: 10px 16px; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%;
    `;
    const statusText = document.createElement('div');
    statusText.style.cssText = 'font-size: 12px; margin-top: 8px; display: none; color: #ccc;';
    const progressOuter = document.createElement('div');
    progressOuter.style.cssText = 'height: 6px; background: #333; border-radius: 3px; margin-top: 6px; display: none; overflow: hidden;';
    const progressInner = document.createElement('div');
    progressInner.style.cssText = 'height: 100%; width: 0%; background: #48bb78; transition: width 0.15s;';
    progressOuter.appendChild(progressInner);
    panel.appendChild(button);
    panel.appendChild(statusText);
    panel.appendChild(progressOuter);
    ui.appendChild(panel);

    function setProgress(label, current, total) {
        statusText.style.display = 'block';
        progressOuter.style.display = 'block';
        const pct = total ? Math.round((current / total) * 100) : 0;
        statusText.textContent = `${label} ${total ? `${current}/${total}` : ''}`.trim();
        progressInner.style.width = `${pct}%`;
        progressInner.style.animation = 'scribd-dl-pulse 1.2s ease-in-out infinite';
    }

    function resetUI(errorMessage) {
        button.disabled = false;
        button.textContent = '⬇ Download PDF';
        progressInner.style.animation = 'none';
        progressInner.style.opacity = '1';
        if (errorMessage) {
            statusText.style.display = 'block';
            statusText.style.color = '#fc8181';
            statusText.textContent = errorMessage;
            progressOuter.style.display = 'none';
        } else {
            statusText.style.display = 'none';
            progressOuter.style.display = 'none';
        }
    }

    // Chrome throttles timers heavily in hidden/backgrounded tabs, which can make an
    // in-progress download look stuck — warn the user rather than let it be a mystery
    let downloadInProgress = false;
    document.addEventListener('visibilitychange', () => {
        if (downloadInProgress && document.hidden) {
            statusText.style.color = '#f6ad55';
            statusText.textContent = 'Paused in background tab — switch back to speed this up';
        } else if (downloadInProgress) {
            statusText.style.color = '#ccc';
        }
    });

    button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Working...';
        statusText.style.color = '#ccc';
        downloadInProgress = true;
        try {
            setProgress('Finding document viewer...', 0, 0);
            const dm = await waitForDocManager();

            const pages = (await collectAllPagesFast(dm, setProgress))
                ?? (await collectAllPagesSlow(dm, setProgress));
            if (!pages.length) throw new Error('No pages found on this page.');

            const images = await downloadAllImages(pages, setProgress);
            const pdfBytes = await buildSearchablePdf(pages, images, setProgress);

            const filename = `${sanitizeFilename(getDocumentTitle())}.pdf`;
            triggerDownload(pdfBytes, filename);
            resetUI();
        } catch (err) {
            console.error('[scribd-dl]', err);
            resetUI(`Failed: ${err.message}`);
        } finally {
            downloadInProgress = false;
        }
    });

    document.body.appendChild(ui);
})();
