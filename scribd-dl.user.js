// ==UserScript==
// @name         Scribd Downloader (Searchable PDF)
// @namespace    https://github.com/furkanyolal/scribd-dl-userscript
// @version      1.0.0
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
     * Force-load every page's content, bypassing the scroll-triggered
     * IntersectionObserver lazy load.
     *
     * Scribd's own per-page loader (`page.load()`) fetches each page's
     * content via a <script> tag pointing at a JSONP endpoint. Fetching the
     * same JSONP URL ourselves with real concurrency measured ~12x faster
     * (1.5s vs ~18s for ~572 pages) — fetch `page.contentUrl` directly,
     * parse the JSONP wrapper, then feed the HTML into Scribd's own
     * `_setContainerContents()` (the same method `.load()` ultimately calls)
     * so layout/positioning stays identical. `loadFonts()` must be called
     * first — without it the text layer's spans measure as zero-width,
     * since the glyphs' CSS isn't registered yet.
     *
     * Insertion is batched (not one synchronous pass over all ~576 pages)
     * with a yield between batches — not for raw speed (a focused tab
     * handles the whole thing in ~1.5s either way) but so the tab stays
     * responsive and keeps making progress even if it gets backgrounded
     * mid-run, rather than risking a long unresponsive stretch.
     *
     * We deliberately do NOT call display() or trigger the <img> elements'
     * native src here — we only need the `orig` attribute to compute each
     * image's URL ourselves (via dm.subImageSrc) and fetch it directly
     * later, so letting the browser also download every image through the
     * DOM would fetch ~576 images twice for no benefit. getBoundingClientRect()
     * on the text layer spans returns identical values with or without
     * display(), so skipping it doesn't affect text-position extraction.
     *
     * Falls back to the native .load() path if Scribd's internal API shape
     * ever changes underneath us.
     */
    async function forceLoadAllPages(dm, onProgress) {
        const pageCount = Object.keys(dm.pages).length;
        const targets = [];
        for (let n = 1; n <= pageCount; n++) {
            const p = dm.pages[n];
            if (p && !p.innerPageElem && !p.loadHasStarted) targets.push(n);
        }

        const canFastLoad = targets.length > 0
            && typeof dm._appendToken === 'function'
            && typeof dm.pages[targets[0]]?.loadFonts === 'function'
            && typeof dm.pages[targets[0]]?._setContainerContents === 'function';

        if (!canFastLoad) {
            const waitUntil = (cond, timeoutMs) => new Promise((resolve) => {
                const deadline = Date.now() + timeoutMs;
                const tick = () => {
                    if (cond() || Date.now() > deadline) return resolve(cond());
                    setTimeout(tick, 100);
                };
                tick();
            });
            for (const n of targets) dm.pages[n].load();
            await waitUntil(() => {
                let loaded = 0;
                for (let n = 1; n <= pageCount; n++) if (dm.pages[n]?.innerPageElem) loaded++;
                onProgress?.('Loading page content...', loaded, pageCount);
                return loaded === pageCount;
            }, 60000);
            return;
        }

        // Phase 1: fetch every page's content concurrently (network-bound).
        const htmlByPage = new Map();
        const CONCURRENCY = 24;
        let idx = 0;
        let completed = 0;
        const fetchOne = async (n, attempts = 3) => {
            dm.pages[n].loadHasStarted = true;
            for (let a = 0; a < attempts; a++) {
                try {
                    const resp = await fetch(dm._appendToken(dm.pages[n].contentUrl));
                    const html = parsePageJsonp(await resp.text());
                    if (html) {
                        htmlByPage.set(n, html);
                        return;
                    }
                } catch {
                    // retry below
                }
                await new Promise((r) => setTimeout(r, 300 * (a + 1)));
            }
            // leave unset on persistent failure; collectPageData skips it
        };
        const fetchWorker = async () => {
            while (idx < targets.length) {
                await fetchOne(targets[idx++]);
                completed++;
                onProgress?.('Loading page content...', completed, targets.length);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, fetchWorker));

        // Phase 2: insert fetched content in batches, yielding between each
        // so a backgrounded/busy tab can't get stuck unresponsive for long.
        const RENDER_BATCH_SIZE = 40;
        onProgress?.('Rendering page content...', 0, targets.length);
        for (let i = 0; i < targets.length; i += RENDER_BATCH_SIZE) {
            const batch = targets.slice(i, i + RENDER_BATCH_SIZE);
            for (const n of batch) {
                const html = htmlByPage.get(n);
                if (!html) continue;
                const p = dm.pages[n];
                p.loadFonts();
                p._setContainerContents(html);
            }
            onProgress?.('Rendering page content...', Math.min(i + RENDER_BATCH_SIZE, targets.length), targets.length);
            await new Promise((r) => setTimeout(r, 0));
        }
    }

    /**
     * Collect each page's source image URL, true dimensions, and OCR'd text
     * runs (position + font size) directly from the already-fetched content
     */
    function collectPageData(dm) {
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
        const { PDFDocument, rgb } = PDFLib;
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        const fontBytes = await loadUnicodeFont();
        const font = await pdfDoc.embedFont(fontBytes, { subset: true });

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
    }

    function resetUI(errorMessage) {
        button.disabled = false;
        button.textContent = '⬇ Download PDF';
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

            await forceLoadAllPages(dm, setProgress);
            setProgress('Collecting page content...', 0, 0);
            const pages = collectPageData(dm);
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
