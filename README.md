# Scribd Downloader (Searchable PDF) — Userscript

A [Tampermonkey](https://www.tampermonkey.net/) userscript that adds a **Download PDF** button with a live progress bar directly onto Scribd document pages. Builds a fully searchable PDF — real, selectable, Ctrl+F-able text — straight in your browser, using the page's own OCR'd content. No extension install beyond Tampermonkey, no server, no uploading anything anywhere.

## ⚠️ Legal & Ethical Notice

This tool is provided for use only on documents you have legal permission to download — for example:

- Documents you've uploaded yourself
- Public-domain documents
- Works you've licensed
- Scribd content you have access to under your account *where offline saving is explicitly permitted*

Downloading or redistributing copyrighted material you don't own or have a license for may violate copyright law and Scribd's Terms of Service. This script does not remove paywalls, bypass access controls, or provide unauthorized access — it works only with content your browser session can already see. Use responsibly and consult legal advice if unsure about your rights to a given document.

This project is not affiliated with, endorsed by, or sponsored by Scribd.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open [`scribd-dl.user.js`](./scribd-dl.user.js), click **Raw**, and Tampermonkey will prompt to install it. (Or: Tampermonkey dashboard → Utilities → Import from URL → paste the raw file URL.)
3. Visit any `scribd.com/document/...` page. A **⬇ Download PDF** button appears bottom-right.

## How it works

Scribd's own page viewer (`docManager`) already has everything needed to reconstruct the document:

- Each page's real scan image URL (computed the same way the site itself computes it)
- Each page's OCR'd text layer — the text Scribd uses for its own in-page search — with position and font-size data

The script fetches that content directly, downloads each page's source image, and assembles a PDF with [`pdf-lib`](https://pdf-lib.js.org/): the visible image on top, an invisible (but fully selectable/searchable) text layer drawn from the OCR data underneath. A bundled [Noto Sans](https://fonts.google.com/noto/specimen/Noto+Sans) font (OFL-licensed) handles non-Latin characters that standard PDF fonts can't encode.

It deliberately avoids Chromium's print-to-PDF pipeline (slow, and re-rasterizes images far larger than the originals) and Scribd's own `<script>`-tag content loader (also slow) — fetching everything directly with real concurrency instead.

## Notes

- Large documents (hundreds of pages) can take anywhere from ~20 seconds to a couple minutes depending on document size and your connection — a progress bar shows what phase it's in.
- **Keep the tab visible/focused while it runs.** Chrome throttles background tabs heavily, which can make this take much longer. The script will warn you if you switch away mid-download.
- OCR quality (including the text layer's accuracy) comes from Scribd, not this script — text position/content faithfully mirrors whatever Scribd's own viewer has.

## Related

A companion CLI/desktop tool with the same searchable-PDF pipeline (plus Slideshare and Everand podcast support) exists as a separate project.

## License

[MIT](./LICENSE)
