const dns = require("dns");
// 1. إجبار Node.js على تفضيل IPv4 لحل مشكلة socket hang up على Render
if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
}

const https = require("https");
const http = require("http");
const { Telegraf, Markup } = require("telegraf");
const { hitomi, Extension } = require("node-hitomi");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");

// 2. ضبط sharp ليتناسب مع رام Render المجانية (512MB) ومعالج 0.1 CPU
sharp.cache(false);
sharp.concurrency(1);

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_TELEGRAM_ID);
const PORT = Number(process.env.PORT) || 10000;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!Number.isSafeInteger(OWNER_ID) || OWNER_ID <= 0) {
    throw new Error("OWNER_TELEGRAM_ID is missing or invalid");
}

const CONFIG = {
    maxPagesPerJob: 400,
    maxImageBytes: 25 * 1024 * 1024,
    downloadRetries: 3,
    uploadRetries: 4,
    maxPdfBytes: 45 * 1024 * 1024,
    photoGroupSize: 10,
    maxSearchResults: 60,
    searchPageSize: 5,
    requestDelayMs: 180,
    maxCacheEntries: 120,
    sessionTtlMs: 30 * 60 * 1000,
    metaFetchConcurrency: 3
};

// إعدادات قابلة للتعديل أثناء التشغيل عبر /settings
const userSettings = {
    quality: "balanced", // balanced | high | lite
    pdfPagesPerPart: 25  // 25 | 50 | 80
};

const QUALITY_PRESETS = {
    lite:     { label: "خفيفة (أسرع)",   maxWidth: 960,  q1: 62, q2: 48, targetBytes: 110 * 1024 },
    balanced: { label: "متوازنة (موصى بها)", maxWidth: 1280, q1: 72, q2: 55, targetBytes: 155 * 1024 },
    high:     { label: "عالية",          maxWidth: 1600, q1: 82, q2: 68, targetBytes: 260 * 1024 }
};

// 3. Agent مخصص يجبر الاتصال على IPv4 ويمنع تعليق الـ Sockets الميتة
const telegramAgent = new https.Agent({
    keepAlive: false,
    family: 4,
    timeout: 120_000
});

const bot = new Telegraf(BOT_TOKEN, {
    handlerTimeout: 180_000,
    telegram: {
        agent: telegramAgent,
        attachmentAgent: telegramAgent,
        apiTimeout: 120_000
    }
});

let shuttingDown = false;
let botStarted = false;
let currentJob = null; // { id, galleryId, mode, cancelled }

const sessions = new Map();
const galleryMetaCache = new Map(); // id -> { meta, cachedAt }

// Render health-check server
const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Bot is alive | Active job: ${currentJob ? currentJob.galleryId : "none"}\n`);
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Health server listening on ${PORT}`);
});

// تنظيف دوري للجلسات المنتهية لحماية الرام
setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions.entries()) {
        if (now - (session.updatedAt || 0) > CONFIG.sessionTtlMs) {
            sessions.delete(key);
        }
    }
}, 10 * 60 * 1000).unref();

/* ===================== أدوات مساعدة وتنسيق ===================== */

function isOwner(ctx) {
    return Boolean(ctx.from && ctx.from.id === OWNER_ID);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function safeError(err) {
    return String((err && (err.message || err)) || "Unknown error").slice(0, 400);
}

function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function truncate(str, max = 50) {
    const s = String(str || "").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function sanitizeFilename(name, fallback) {
    const cleaned = String(name || "")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .replace(/\s+/g, "_")
        .slice(0, 48);
    return cleaned || fallback;
}

function renderProgressBar(current, total, width = 10) {
    const ratio = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
    const filled = Math.round(ratio * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const pct = Math.round(ratio * 100);
    return `<code>[${bar}] ${pct}%</code>`;
}

function languageFlag(lang) {
    const l = String(lang || "").toLowerCase();
    if (l.includes("arab")) return "🇸🇦";
    if (l.includes("eng")) return "🇬🇧";
    if (l.includes("jap")) return "🇯🇵";
    if (l.includes("chin")) return "🇨🇳";
    if (l.includes("kor")) return "🇰🇷";
    if (l.includes("span")) return "🇪🇸";
    if (l.includes("fren")) return "🇫🇷";
    if (l.includes("russ")) return "🇷🇺";
    if (l.includes("germ")) return "🇩🇪";
    return "🌐";
}

function extractGalleryId(text) {
    const input = String(text || "").trim();

    if (/^\d+$/.test(input)) {
        const id = Number(input);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    }

    try {
        const url = new URL(input);
        const host = url.hostname.toLowerCase();
        if (host !== "hitomi.la" && host !== "www.hitomi.la") return null;

        const match =
            url.pathname.match(/^\/(?:reader|galleries|manga|doujinshi|cg|gamecg|imageset)\/.*?(?:(\d+))\.html$/i) ||
            url.pathname.match(/^\/reader\/(\d+)\.html$/i);
        if (!match) return null;

        const id = Number(match[1]);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    } catch (_) {
        return null;
    }
}

function getCommandQuery(ctx, command) {
    const text = String((ctx.message && ctx.message.text) || "");
    return text.replace(new RegExp("^\\/" + command + "(?:@\\w+)?\\s*", "i"), "").trim();
}

function getGalleryIdFromResult(item) {
    if (typeof item === "number") {
        return Number.isSafeInteger(item) && item > 0 ? item : null;
    }
    const raw = item && (item.id || item.galleryid || item.galleryId);
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/* ===================== استخراج وكاش بيانات المعارض ===================== */

function extractMetadata(gallery, fallbackId) {
    const id = Number(gallery && gallery.id) || fallbackId;
    const title =
        (gallery && gallery.title && typeof gallery.title.display === "string" && gallery.title.display.trim()) ||
        (gallery && typeof gallery.title === "string" && gallery.title.trim()) ||
        `معرض #${id}`;

    const japaneseTitle =
        gallery && gallery.title && typeof gallery.title.japanese === "string"
            ? gallery.title.japanese.trim()
            : "";

    const type = (gallery && gallery.type) ? String(gallery.type) : "غير محدد";

    let language = "غير محددة";
    if (gallery && gallery.languageName) {
        language = gallery.languageName.english || gallery.languageName.local || language;
    } else if (gallery && typeof gallery.language === "string" && gallery.language) {
        language = gallery.language;
    }

    const artists = Array.isArray(gallery && gallery.artists) ? gallery.artists.filter(Boolean) : [];
    const groups = Array.isArray(gallery && gallery.groups) ? gallery.groups.filter(Boolean) : [];
    const series = Array.isArray(gallery && (gallery.series || gallery.parodies))
        ? (gallery.series || gallery.parodies).filter(Boolean)
        : [];

    const rawTags = Array.isArray(gallery && gallery.tags) ? gallery.tags : [];
    const tags = rawTags
        .map(t => {
            if (typeof t === "string") return t;
            if (!t || typeof t !== "object") return "";
            const name = t.name || t.tag || "";
            if (!name) return "";
            if (t.type === "female" || t.female) return `♀️ ${name}`;
            if (t.type === "male" || t.male) return `♂️ ${name}`;
            return name;
        })
        .filter(Boolean);

    const pageCount = Array.isArray(gallery && gallery.files) ? gallery.files.length : 0;

    return {
        id,
        title,
        japaneseTitle,
        type,
        language,
        artists,
        groups,
        series,
        tags,
        pageCount,
        url: `https://hitomi.la/reader/${id}.html`
    };
}

function setCachedMeta(id, meta) {
    if (galleryMetaCache.size >= CONFIG.maxCacheEntries) {
        const oldestKey = galleryMetaCache.keys().next().value;
        galleryMetaCache.delete(oldestKey);
    }
    galleryMetaCache.set(id, { meta, cachedAt: Date.now() });
}

function getCachedMeta(id) {
    const entry = galleryMetaCache.get(id);
    return entry ? entry.meta : null;
}

async function withRetry(fn, retries = CONFIG.downloadRetries, label = "operation") {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            console.error(`${label} failed (${attempt}/${retries}):`, safeError(err));

            const retryAfter = err && err.response && err.response.parameters && err.response.parameters.retry_after;
            if (retryAfter) {
                await sleep((Number(retryAfter) + 1) * 1000);
                continue;
            }
            if (attempt < retries) {
                await sleep(Math.min(2000 * attempt, 8000));
            }
        }
    }
    throw lastError || new Error(`${label} failed`);
}

async function fetchGalleryFull(galleryId) {
    const gallery = await withRetry(
        () => hitomi.galleries.retrieve(galleryId),
        CONFIG.downloadRetries,
        `Gallery ${galleryId} retrieve`
    );
    if (!gallery) throw new Error("لم يتم العثور على المعرض.");

    const meta = extractMetadata(gallery, galleryId);
    setCachedMeta(galleryId, meta);
    return { gallery, meta, images: Array.isArray(gallery.files) ? gallery.files : [] };
}

async function hydrateGalleryIds(ids) {
    const results = new Array(ids.length);
    let cursor = 0;

    async function worker() {
        while (cursor < ids.length) {
            const idx = cursor++;
            const id = ids[idx];
            const cached = getCachedMeta(id);
            if (cached) {
                results[idx] = cached;
                continue;
            }
            try {
                const { meta } = await fetchGalleryFull(id);
                results[idx] = meta;
            } catch (_) {
                results[idx] = {
                    id,
                    title: `معرض #${id}`,
                    type: "—",
                    language: "—",
                    artists: [],
                    tags: [],
                    pageCount: 0,
                    url: `https://hitomi.la/reader/${id}.html`
                };
            }
        }
    }

    const workers = Array.from(
        { length: Math.min(CONFIG.metaFetchConcurrency, ids.length) },
        () => worker()
    );
    await Promise.all(workers);
    return results;
}

/* ===================== معالجة الصور و PDF والرفع ===================== */

async function fetchImageBuffer(image, pageNumber) {
    const data = await withRetry(
        () => image.fetch(Extension.Webp),
        CONFIG.downloadRetries,
        `Image ${pageNumber} download`
    );
    const buffer = Buffer.from(data);
    if (!buffer.length) throw new Error(`الصورة ${pageNumber} فارغة`);
    if (buffer.length > CONFIG.maxImageBytes) throw new Error(`حجم الصورة ${pageNumber} كبير جدًا`);
    return buffer;
}

async function compressCoverThumbnail(input) {
    return sharp(input, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: 720, withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 78, mozjpeg: true, progressive: true })
        .toBuffer();
}

async function compressImage(input) {
    const preset = QUALITY_PRESETS[userSettings.quality] || QUALITY_PRESETS.balanced;

    const pipeline = sharp(input, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: preset.maxWidth, withoutEnlargement: true })
        .flatten({ background: "#ffffff" });

    let { data, info } = await pipeline
        .jpeg({ quality: preset.q1, mozjpeg: true, progressive: true })
        .toBuffer({ resolveWithObject: true });

    if (data.length > preset.targetBytes * 1.6) {
        const smallerWidth = Math.max(600, Math.floor((info.width || preset.maxWidth) * 0.78));
        const secondPass = await sharp(data)
            .resize({ width: smallerWidth, withoutEnlargement: true })
            .jpeg({ quality: preset.q2, mozjpeg: true, progressive: true })
            .toBuffer({ resolveWithObject: true });

        data = secondPass.data;
        info = secondPass.info;
    }

    return {
        buffer: data,
        width: info.width || 800,
        height: info.height || 1200
    };
}

async function createPdf(processedImages) {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < processedImages.length; i++) {
        const { buffer, width, height } = processedImages[i];
        const image = await pdf.embedJpg(buffer);
        const page = pdf.addPage([width, height]);
        page.drawImage(image, { x: 0, y: 0, width, height });
    }
    return Buffer.from(await pdf.save({ useObjectStreams: true }));
}

async function sendPhotoBuffer(chatId, photoBuffer, captionHtml, replyMarkup) {
    return withRetry(async () => {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("caption", captionHtml.slice(0, 1020));
        form.append("parse_mode", "HTML");
        if (replyMarkup) {
            form.append("reply_markup", JSON.stringify(replyMarkup));
        }
        form.append("photo", new Blob([photoBuffer], { type: "image/jpeg" }), "cover.jpg");

        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(90_000)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
            const err = new Error(data.description || `HTTP ${res.status}`);
            err.response = data;
            throw err;
        }
        return data.result;
    }, 2, "Cover photo upload");
}

async function uploadPdf(chatId, pdfBuffer, meta, partNumber, totalParts) {
    if (pdfBuffer.length > CONFIG.maxPdfBytes) {
        throw new Error(`حجم PDF (${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB) تجاوز حد البوت الآمن.`);
    }

    const safeTitle = sanitizeFilename(meta.title, `hitomi_${meta.id}`);
    const fileName = totalParts > 1
        ? `[${meta.id}]_${safeTitle}_part${partNumber}.pdf`
        : `[${meta.id}]_${safeTitle}.pdf`;

    const caption =
        `📕 <b>${escapeHtml(truncate(meta.title, 120))}</b>\n` +
        `🆔 <code>${meta.id}</code>` +
        (totalParts > 1 ? ` • الجزء <b>${partNumber}/${totalParts}</b>` : "");

    await withRetry(async () => {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("caption", caption);
        form.append("parse_mode", "HTML");
        form.append("document", new Blob([pdfBuffer], { type: "application/pdf" }), fileName);

        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(120_000)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
            const err = new Error(data.description || `HTTP ${res.status}`);
            err.response = data;
            throw err;
        }
    }, CONFIG.uploadRetries, `PDF upload part ${partNumber}`);
}

async function uploadPhotoGroup(chatId, processedImages, galleryId, firstPageNumber) {
    await withRetry(async () => {
        const form = new FormData();
        form.append("chat_id", String(chatId));

        const media = processedImages.map((img, index) => {
            const fieldName = `photo_${index}`;
            form.append(
                fieldName,
                new Blob([img.buffer], { type: "image/jpeg" }),
                `hitomi_${galleryId}_p${firstPageNumber + index}.jpg`
            );
            return { type: "photo", media: `attach://${fieldName}` };
        });

        form.append("media", JSON.stringify(media));

        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(120_000)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
            const err = new Error(data.description || `HTTP ${res.status}`);
            err.response = data;
            throw err;
        }
    }, CONFIG.uploadRetries, `Photo group starting page ${firstPageNumber}`);
}

/* ===================== بناء الواجهات والبطاقات ===================== */

function buildGalleryCardCaption(meta) {
    const lines = [];
    lines.push(`📚 <b>${escapeHtml(truncate(meta.title, 180))}</b>`);
    if (meta.japaneseTitle && meta.japaneseTitle !== meta.title) {
        lines.push(`<i>${escapeHtml(truncate(meta.japaneseTitle, 110))}</i>`);
    }
    lines.push("");
    lines.push(`🆔 المعرّف: <code>${meta.id}</code>`);
    lines.push(`📄 الصفحات: <b>${meta.pageCount || "?"}</b>  |  🏷️ النوع: <b>${escapeHtml(meta.type)}</b>`);
    lines.push(`${languageFlag(meta.language)} اللغة: <b>${escapeHtml(meta.language)}</b>`);

    if (meta.artists.length) {
        lines.push(`🎨 الرسام: ${escapeHtml(meta.artists.slice(0, 4).join("، "))}`);
    }
    if (meta.series.length) {
        lines.push(`🎬 السلسلة: ${escapeHtml(meta.series.slice(0, 3).join("، "))}`);
    }
    if (meta.tags.length) {
        const tagList = meta.tags.slice(0, 18).map(escapeHtml).join(" • ");
        const more = meta.tags.length > 18 ? ` (+${meta.tags.length - 18})` : "";
        lines.push(`\n<blockquote expandable>🏷️ التاغات:\n${tagList}${more}</blockquote>`);
    }

    return lines.join("\n").slice(0, 1020);
}

function buildGalleryCardKeyboard(meta) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("📕 تحميل PDF", `pdf:${meta.id}`),
            Markup.button.callback("🖼️ إرسال كصور", `photos:${meta.id}`)
        ],
        [
            Markup.button.url("🌐 فتح في Hitomi", meta.url),
            Markup.button.callback("🗑️ إغلاق", "dismiss")
        ]
    ]).reply_markup;
}

async function sendGalleryCard(ctx, galleryId) {
    await ctx.sendChatAction("upload_photo").catch(() => {});
    const loadingMsg = await ctx.reply(`⏳ جاري جلب تفاصيل وغلاف المعرض <code>${galleryId}</code>...`, {
        parse_mode: "HTML"
    });

    try {
        const { meta, images } = await fetchGalleryFull(galleryId);
        const caption = buildGalleryCardCaption(meta);
        const keyboard = buildGalleryCardKeyboard(meta);

        let coverBuffer = null;
        if (images.length > 0) {
            try {
                const rawCover = await fetchImageBuffer(images[0], 1);
                coverBuffer = await compressCoverThumbnail(rawCover);
            } catch (err) {
                console.error("Cover fetch skipped:", safeError(err));
            }
        }

        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

        if (coverBuffer) {
            await sendPhotoBuffer(ctx.chat.id, coverBuffer, caption, keyboard);
        } else {
            await ctx.reply(caption, { parse_mode: "HTML", reply_markup: keyboard });
        }
    } catch (err) {
        await ctx.telegram
            .editMessageText(
                ctx.chat.id,
                loadingMsg.message_id,
                undefined,
                `❌ تعذر فتح المعرض <code>${galleryId}</code>:\n${escapeHtml(safeError(err))}`,
                { parse_mode: "HTML" }
            )
            .catch(() => {});
    }
}

/* ===================== محرك البحث والعرض ===================== */

async function searchTagCandidates(query) {
    const term = String(query || "").trim().replace(/\s+/g, "_");
    if (!term) return [];

    const raw = await hitomi.tags.search(term);
    if (!Array.isArray(raw)) return [];

    return raw
        .map(entry => {
            if (!Array.isArray(entry) || !entry[0]) return null;
            return { tagText: String(entry[0]).trim(), count: Number(entry[1]) || 0 };
        })
        .filter(item => item && item.tagText)
        .slice(0, CONFIG.maxSearchResults);
}

function makeTagView(query, tags, page = 0) {
    const totalPages = Math.max(1, Math.ceil(tags.length / CONFIG.searchPageSize));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const start = safePage * CONFIG.searchPageSize;
    const current = tags.slice(start, start + CONFIG.searchPageSize);

    const text =
        `🏷️ <b>نتائج التاغات:</b> <code>${escapeHtml(query)}</code>\n` +
        `📊 العدد: <b>${tags.length}</b> • الصفحة <b>${safePage + 1}/${totalPages}</b>\n\n` +
        `اختر التاغ المطلوب لعرض معارضه:`;

    const rows = current.map((item, idx) => [
        Markup.button.callback(
            `${start + idx + 1}. ${truncate(item.tagText, 40)} (${item.count})`,
            `tagpick:${start + idx}`
        )
    ]);

    const nav = [];
    if (safePage > 0) nav.push(Markup.button.callback("⬅️ السابق", `tagpage:${safePage - 1}`));
    if (safePage < totalPages - 1) nav.push(Markup.button.callback("التالي ➡️", `tagpage:${safePage + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([Markup.button.callback("🗑️ إغلاق", "dismiss")]);

    return { text, keyboard: Markup.inlineKeyboard(rows).reply_markup };
}

async function buildGalleryPageView(session, page = 0) {
    const ids = session.galleryIds;
    const totalPages = Math.max(1, Math.ceil(ids.length / CONFIG.searchPageSize));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const start = safePage * CONFIG.searchPageSize;
    const pageIds = ids.slice(start, start + CONFIG.searchPageSize);

    // جلب العناوين والتفاصيل للصفحة الحالية فقط (مع الكاش)
    const metas = await hydrateGalleryIds(pageIds);

    const header =
        `🔎 <b>نتائج البحث:</b> <code>${escapeHtml(session.query)}</code>\n` +
        `📊 الإجمالي: <b>${ids.length}</b> • الصفحة <b>${safePage + 1}/${totalPages}</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n`;

    const body = metas
        .map((m, idx) => {
            const num = start + idx + 1;
            const artistStr = m.artists.length ? ` • 🎨 ${escapeHtml(truncate(m.artists[0], 22))}` : "";
            return (
                `<b>${num}.</b> ${escapeHtml(truncate(m.title, 75))}\n` +
                `   ${languageFlag(m.language)} ${escapeHtml(m.language)} • 📄 ${m.pageCount || "?"}ص • <code>${m.id}</code>${artistStr}`
            );
        })
        .join("\n\n");

    const rows = metas.map((m, idx) => [
        Markup.button.callback(
            `📖 ${start + idx + 1}. ${truncate(m.title, 42)}`,
            `gallery:${m.id}`
        )
    ]);

    const nav = [];
    if (safePage > 0) nav.push(Markup.button.callback("⬅️ السابق", `gallerypage:${safePage - 1}`));
    nav.push(Markup.button.callback(`${safePage + 1}/${totalPages}`, "noop"));
    if (safePage < totalPages - 1) nav.push(Markup.button.callback("التالي ➡️", `gallerypage:${safePage + 1}`));
    rows.push(nav);
    rows.push([Markup.button.callback("🗑️ إغلاق", "dismiss")]);

    return {
        text: (header + body).slice(0, 4050),
        keyboard: Markup.inlineKeyboard(rows).reply_markup
    };
}

async function runGallerySearch(ctx, query, mode, rawResults, editMessageId = null) {
    const galleryIds = (Array.isArray(rawResults) ? rawResults : [])
        .map(getGalleryIdFromResult)
        .filter(Boolean)
        .slice(0, CONFIG.maxSearchResults);

    if (!galleryIds.length) {
        const msg = `لم أجد أي معارض مطابقة لـ <code>${escapeHtml(query)}</code>.`;
        if (editMessageId) {
            return ctx.telegram.editMessageText(ctx.chat.id, editMessageId, undefined, msg, { parse_mode: "HTML" }).catch(() => {});
        }
        return ctx.reply(msg, { parse_mode: "HTML" });
    }

    const session = {
        type: "galleries",
        query,
        mode,
        galleryIds,
        updatedAt: Date.now()
    };
    sessions.set(ctx.from.id, session);

    const { text, keyboard } = await buildGalleryPageView(session, 0);

    if (editMessageId) {
        return ctx.telegram
            .editMessageText(ctx.chat.id, editMessageId, undefined, text, {
                parse_mode: "HTML",
                reply_markup: keyboard
            })
            .catch(() => {});
    }

    return ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

/* ===================== الإعدادات ===================== */

function buildSettingsView() {
    const preset = QUALITY_PRESETS[userSettings.quality];
    const text =
        `⚙️ <b>إعدادات البوت الحالية</b>\n\n` +
        `🖼️ جودة الصور: <b>${preset.label}</b> (عرض ${preset.maxWidth}px)\n` +
        `📕 صفحات كل جزء PDF: <b>${userSettings.pdfPagesPerPart} صفحة</b>\n` +
        `🧠 المعارض في الكاش: <b>${galleryMetaCache.size}/${CONFIG.maxCacheEntries}</b>`;

    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback(userSettings.quality === "lite" ? "✅ خفيفة" : "خفيفة", "set_q:lite"),
            Markup.button.callback(userSettings.quality === "balanced" ? "✅ متوازنة" : "متوازنة", "set_q:balanced"),
            Markup.button.callback(userSettings.quality === "high" ? "✅ عالية" : "عالية", "set_q:high")
        ],
        [
            Markup.button.callback(userSettings.pdfPagesPerPart === 25 ? "✅ 25ص/PDF" : "25ص/PDF", "set_p:25"),
            Markup.button.callback(userSettings.pdfPagesPerPart === 50 ? "✅ 50ص/PDF" : "50ص/PDF", "set_p:50"),
            Markup.button.callback(userSettings.pdfPagesPerPart === 80 ? "✅ 80ص/PDF" : "80ص/PDF", "set_p:80")
        ],
        [
            Markup.button.callback("🧹 مسح الكاش", "clear_cache"),
            Markup.button.callback("🗑️ إغلاق", "dismiss")
        ]
    ]).reply_markup;

    return { text, keyboard };
}

/* ===================== معالجة التحميل والرفع ===================== */

async function updateProgress(chatId, messageId, html, allowCancel = true) {
    const extra = { parse_mode: "HTML" };
    if (allowCancel && currentJob) {
        extra.reply_markup = Markup.inlineKeyboard([
            [Markup.button.callback("❌ إلغاء العملية", `cancel:${currentJob.id}`)]
        ]).reply_markup;
    }
    return bot.telegram.editMessageText(chatId, messageId, undefined, html, extra).catch(() => {});
}

async function processGallery(chatId, galleryId, mode) {
    if (currentJob) {
        await bot.telegram
            .sendMessage(chatId, "⏳ هناك عملية أخرى قيد التنفيذ حالياً. يمكنك إلغاؤها أو انتظار انتهائها.")
            .catch(() => {});
        return;
    }

    const job = { id: String(Date.now()), galleryId, mode, cancelled: false };
    currentJob = job;

    let completed = 0;
    let failed = 0;
    let statusMessage = null;
    const startedAt = Date.now();

    try {
        statusMessage = await bot.telegram.sendMessage(
            chatId,
            `📥 جاري تجهيز المعرض <code>${galleryId}</code>...`,
            { parse_mode: "HTML" }
        );

        const { meta, images } = await fetchGalleryFull(galleryId);
        if (!images.length) throw new Error("لم يتم العثور على صفحات المعرض.");
        if (images.length > CONFIG.maxPagesPerJob) {
            throw new Error(`المعرض يحتوي على ${images.length} صفحة (الحد الأقصى ${CONFIG.maxPagesPerJob}).`);
        }

        const total = images.length;
        const modeLabel = mode === "pdf" ? "PDF مضغوط" : "ألبومات صور";

        await updateProgress(
            chatId,
            statusMessage.message_id,
            `📚 <b>${escapeHtml(truncate(meta.title, 90))}</b>\n` +
            `⚙️ الوضع: <b>${modeLabel}</b> • الصفحات: <b>${total}</b>\n\n` +
            `${renderProgressBar(0, total)}\n` +
            `⏳ جاري تحميل وضغط الصور...`
        );

        if (mode === "photos") {
            for (let start = 0; start < total; start += CONFIG.photoGroupSize) {
                if (job.cancelled) break;

                const end = Math.min(start + CONFIG.photoGroupSize, total);
                const group = [];

                for (let i = start; i < end; i++) {
                    if (job.cancelled) break;
                    try {
                        const raw = await fetchImageBuffer(images[i], i + 1);
                        const compressed = await compressImage(raw);
                        group.push(compressed);
                        completed++;
                    } catch (err) {
                        failed++;
                        console.error(`Page ${i + 1} failed:`, safeError(err));
                    }
                    await sleep(CONFIG.requestDelayMs);
                }

                if (job.cancelled) {
                    group.length = 0;
                    break;
                }

                if (group.length) {
                    bot.telegram.sendChatAction(chatId, "upload_photo").catch(() => {});
                    await uploadPhotoGroup(chatId, group, galleryId, start + 1);
                    group.length = 0;
                }

                await updateProgress(
                    chatId,
                    statusMessage.message_id,
                    `📚 <b>${escapeHtml(truncate(meta.title, 80))}</b>\n` +
                    `${renderProgressBar(end, total)}\n` +
                    `📄 التقدم: <b>${end}/${total}</b> • ✅ ${completed} • ⚠️ ${failed}`
                );
            }
        } else {
            const pagesPerPart = userSettings.pdfPagesPerPart;
            const totalParts = Math.ceil(total / pagesPerPart);

            for (let part = 0; part < totalParts; part++) {
                if (job.cancelled) break;

                const start = part * pagesPerPart;
                const end = Math.min(start + pagesPerPart, total);
                const processedImages = [];

                for (let i = start; i < end; i++) {
                    if (job.cancelled) break;
                    try {
                        const raw = await fetchImageBuffer(images[i], i + 1);
                        const compressed = await compressImage(raw);
                        processedImages.push(compressed);
                        completed++;
                    } catch (err) {
                        failed++;
                        console.error(`Page ${i + 1} failed:`, safeError(err));
                    }
                    await sleep(CONFIG.requestDelayMs);
                }

                if (job.cancelled) {
                    processedImages.length = 0;
                    break;
                }

                if (processedImages.length) {
                    const pdfBuffer = await createPdf(processedImages);
                    processedImages.length = 0;

                    bot.telegram.sendChatAction(chatId, "upload_document").catch(() => {});
                    await uploadPdf(chatId, pdfBuffer, meta, part + 1, totalParts);
                }

                await updateProgress(
                    chatId,
                    statusMessage.message_id,
                    `📚 <b>${escapeHtml(truncate(meta.title, 80))}</b>\n` +
                    `${renderProgressBar(end, total)}\n` +
                    `📕 الجزء: <b>${part + 1}/${totalParts}</b> • 📄 ${end}/${total}\n` +
                    `✅ الناجحة: ${completed} • ⚠️ الفاشلة: ${failed}`
                );
            }
        }

        const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));

        if (job.cancelled) {
            await updateProgress(
                chatId,
                statusMessage.message_id,
                `🛑 <b>تم إلغاء العملية</b>\n` +
                `🆔 المعرض: <code>${galleryId}</code>\n` +
                `✅ ما تم إنجازه: ${completed} صفحة (${elapsedSec}ث)`,
                false
            );
        } else {
            await updateProgress(
                chatId,
                statusMessage.message_id,
                `✅ <b>اكتملت المعالجة بنجاح!</b>\n\n` +
                `📚 ${escapeHtml(truncate(meta.title, 90))}\n` +
                `🆔 <code>${galleryId}</code> • ⏱️ ${elapsedSec} ثانية\n` +
                `📄 الصفحات: <b>${completed}/${total}</b>` +
                (failed ? ` (⚠️ فشل ${failed})` : ""),
                false
            );
        }
    } catch (err) {
        console.error("Gallery job error:", err);
        const errHtml = `❌ <b>تعذرت معالجة المعرض</b> <code>${galleryId}</code>:\n${escapeHtml(safeError(err))}`;
        if (statusMessage) {
            await updateProgress(chatId, statusMessage.message_id, errHtml, false);
        } else {
            await bot.telegram.sendMessage(chatId, errHtml, { parse_mode: "HTML" }).catch(() => {});
        }
    } finally {
        if (currentJob && currentJob.id === job.id) {
            currentJob = null;
        }
    }
}

/* ===================== Middleware والأوامر ===================== */

bot.use(async (ctx, next) => {
    if (ctx.from && !isOwner(ctx)) {
        if (ctx.callbackQuery) return ctx.answerCbQuery("هذا البوت خاص.").catch(() => {});
        if (ctx.message) return ctx.reply("هذا البوت مخصص لصاحبه فقط.").catch(() => {});
        return;
    }
    if (shuttingDown) return;

    try {
        await next();
    } catch (err) {
        console.error("Middleware error:", safeError(err));
    }
});

bot.start(ctx =>
    ctx.reply(
        `👋 <b>أهلاً بك في بوت Hitomi المطور</b>\n\n` +
        `🔍 <b>طرق الاستخدام السريعة:</b>\n` +
        `• أرسل <b>رابط المعرض</b> أو <b>رقمه</b> مباشرة لعرض الغلاف والتفاصيل.\n` +
        `• أرسل <b>أي كلمة بحث</b> مباشرة لتختار البحث بالتاغ أو العنوان.\n\n` +
        `📌 <b>الأوامر المتاحة:</b>\n` +
        `/search <code>كلمة</code> — البحث عن التاغات\n` +
        `/title <code>اسم</code> — البحث بالعنوان\n` +
        `/view <code>المعرف</code> — فتح بطاقة معرض\n` +
        `/settings — ضبط الجودة وتقسيم PDF`,
        { parse_mode: "HTML" }
    )
);

bot.help(ctx =>
    ctx.reply(
        `📖 <b>دليل الأوامر</b>\n\n` +
        `• /search <code>blue archive</code> — بحث بالتاغات\n` +
        `• /title <code>blue archive</code> — بحث بالعنوان\n` +
        `• /view <code>1916532</code> — عرض غلاف وتفاصيل المعرض\n` +
        `• /settings — تخصيص الجودة وحجم أجزاء PDF\n\n` +
        `💡 يمكنك أيضاً إرسال رابط أو رقم المعرض أو أي نص للبحث مباشرة.`,
        { parse_mode: "HTML" }
    )
);

bot.command("settings", ctx => {
    const { text, keyboard } = buildSettingsView();
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
});

bot.command("view", async ctx => {
    const id = extractGalleryId(getCommandQuery(ctx, "view"));
    if (!id) return ctx.reply("مثال: <code>/view 1916532</code>", { parse_mode: "HTML" });
    return sendGalleryCard(ctx, id);
});

bot.command("search", async ctx => {
    const query = getCommandQuery(ctx, "search");
    if (!query) return ctx.reply("مثال: <code>/search blue archive</code>", { parse_mode: "HTML" });

    await ctx.sendChatAction("typing").catch(() => {});
    const wait = await ctx.reply(`🔎 جاري البحث عن التاغات لـ <code>${escapeHtml(query)}</code>...`, { parse_mode: "HTML" });

    try {
        const tags = await searchTagCandidates(query);
        if (!tags.length) {
            return ctx.telegram.editMessageText(
                ctx.chat.id, wait.message_id, undefined,
                "لم أجد تاغات مطابقة. جرّب كلمة أخرى."
            ).catch(() => {});
        }

        sessions.set(ctx.from.id, { type: "tags", query, tags, updatedAt: Date.now() });
        const { text, keyboard } = makeTagView(query, tags, 0);
        return ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, text, {
            parse_mode: "HTML",
            reply_markup: keyboard
        }).catch(() => {});
    } catch (err) {
        return ctx.telegram.editMessageText(
            ctx.chat.id, wait.message_id, undefined,
            `❌ تعذر البحث بالتاغ:\n${escapeHtml(safeError(err))}`,
            { parse_mode: "HTML" }
        ).catch(() => {});
    }
});

bot.command("title", async ctx => {
    const query = getCommandQuery(ctx, "title");
    if (!query) return ctx.reply("مثال: <code>/title blue archive</code>", { parse_mode: "HTML" });

    await ctx.sendChatAction("typing").catch(() => {});
    const wait = await ctx.reply(`🔎 جاري البحث بالعنوان وجلب التفاصيل...`);

    try {
        const results = await hitomi.galleries.list({ title: query });
        await runGallerySearch(ctx, query, "title", results, wait.message_id);
    } catch (err) {
        await ctx.telegram.editMessageText(
            ctx.chat.id, wait.message_id, undefined,
            `❌ تعذر البحث بالعنوان:\n${escapeHtml(safeError(err))}`,
            { parse_mode: "HTML" }
        ).catch(() => {});
    }
});

/* ===================== أزرار التفاعل (Callbacks) ===================== */

bot.action("noop", ctx => ctx.answerCbQuery().catch(() => {}));

bot.action("dismiss", async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return ctx.deleteMessage().catch(() => {});
});

bot.action(/^tagpage:(\d+)$/, async ctx => {
    const page = Number(ctx.match[1]);
    const session = sessions.get(ctx.from.id);
    if (!session || session.type !== "tags") {
        return ctx.answerCbQuery("انتهت جلسة البحث. ابحث مجدداً.", { show_alert: true });
    }
    await ctx.answerCbQuery();
    const { text, keyboard } = makeTagView(session.query, session.tags, page);
    return ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
});

bot.action(/^tagpick:(\d+)$/, async ctx => {
    const index = Number(ctx.match[1]);
    const session = sessions.get(ctx.from.id);
    if (!session || session.type !== "tags" || !session.tags[index]) {
        return ctx.answerCbQuery("انتهت جلسة البحث. ابحث مجدداً.", { show_alert: true });
    }

    const selectedTag = session.tags[index].tagText;
    await ctx.answerCbQuery("جاري جلب المعارض وعناوينها...");
    await ctx.editMessageText(
        `⏳ جاري جلب معارض التاغ <code>${escapeHtml(selectedTag)}</code>...`,
        { parse_mode: "HTML" }
    ).catch(() => {});

    try {
        const parsed = hitomi.tags.parse(selectedTag);
        const results = await hitomi.galleries.list({ tags: parsed });
        await runGallerySearch(ctx, selectedTag, "tags", results, ctx.callbackQuery.message.message_id);
    } catch (err) {
        await ctx.editMessageText(
            `❌ تعذر جلب المعارض لهذا التاغ:\n${escapeHtml(safeError(err))}`,
            { parse_mode: "HTML" }
        ).catch(() => {});
    }
});

bot.action(/^gallerypage:(\d+)$/, async ctx => {
    const page = Number(ctx.match[1]);
    const session = sessions.get(ctx.from.id);
    if (!session || session.type !== "galleries") {
        return ctx.answerCbQuery("انتهت جلسة البحث. ابحث مجدداً.", { show_alert: true });
    }

    await ctx.answerCbQuery("جاري تحميل الصفحة...");
    try {
        const { text, keyboard } = await buildGalleryPageView(session, page);
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
    } catch (err) {
        await ctx.answerCbQuery("تعذر تحميل الصفحة.").catch(() => {});
    }
});

bot.action(/^gallery:(\d+)$/, async ctx => {
    await ctx.answerCbQuery("جاري فتح المعرض...").catch(() => {});
    return sendGalleryCard(ctx, Number(ctx.match[1]));
});

bot.action(/^qsearch:(title|tag)$/, async ctx => {
    const mode = ctx.match[1];
    const session = sessions.get(ctx.from.id);
    if (!session || session.type !== "quick" || !session.query) {
        return ctx.answerCbQuery("انتهت الجلسة، أرسل الكلمة مجدداً.", { show_alert: true });
    }

    const query = session.query;
    const msgId = ctx.callbackQuery.message.message_id;
    await ctx.answerCbQuery("جاري البحث...");

    if (mode === "tag") {
        await ctx.editMessageText(`🔎 جاري البحث عن التاغات لـ <code>${escapeHtml(query)}</code>...`, { parse_mode: "HTML" }).catch(() => {});
        try {
            const tags = await searchTagCandidates(query);
            if (!tags.length) {
                return ctx.editMessageText("لم أجد تاغات مطابقة.").catch(() => {});
            }
            sessions.set(ctx.from.id, { type: "tags", query, tags, updatedAt: Date.now() });
            const { text, keyboard } = makeTagView(query, tags, 0);
            return ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
        } catch (err) {
            return ctx.editMessageText(`❌ خطأ: ${escapeHtml(safeError(err))}`, { parse_mode: "HTML" }).catch(() => {});
        }
    } else {
        await ctx.editMessageText(`🔎 جاري البحث بالعنوان لـ <code>${escapeHtml(query)}</code>...`, { parse_mode: "HTML" }).catch(() => {});
        try {
            const results = await hitomi.galleries.list({ title: query });
            await runGallerySearch(ctx, query, "title", results, msgId);
        } catch (err) {
            await ctx.editMessageText(`❌ خطأ: ${escapeHtml(safeError(err))}`, { parse_mode: "HTML" }).catch(() => {});
        }
    }
});

bot.action(/^set_q:(lite|balanced|high)$/, async ctx => {
    userSettings.quality = ctx.match[1];
    await ctx.answerCbQuery("تم تحديث الجودة ✅");
    const { text, keyboard } = buildSettingsView();
    return ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
});

bot.action(/^set_p:(25|50|80)$/, async ctx => {
    userSettings.pdfPagesPerPart = Number(ctx.match[1]);
    await ctx.answerCbQuery("تم تحديث حجم الجزء ✅");
    const { text, keyboard } = buildSettingsView();
    return ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
});

bot.action("clear_cache", async ctx => {
    galleryMetaCache.clear();
    await ctx.answerCbQuery("تم مسح الكاش 🧹");
    const { text, keyboard } = buildSettingsView();
    return ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
});

bot.action(/^cancel:(\d+)$/, async ctx => {
    const jobId = ctx.match[1];
    if (!currentJob || currentJob.id !== jobId) {
        return ctx.answerCbQuery("هذه العملية انتهت بالفعل.").catch(() => {});
    }
    currentJob.cancelled = true;
    return ctx.answerCbQuery("جاري إلغاء العملية...").catch(() => {});
});

bot.action(/^(pdf|photos):(\d+)$/, async ctx => {
    const mode = ctx.match[1];
    const galleryId = Number(ctx.match[2]);

    if (currentJob) {
        return ctx.answerCbQuery("هناك عملية قيد التنفيذ بالفعل.", { show_alert: true });
    }
    await ctx.answerCbQuery("بدأت المعالجة 🚀").catch(() => {});

    processGallery(ctx.chat.id, galleryId, mode).catch(err => {
        console.error("Background job error:", safeError(err));
    });
});

// استقبال الروابط، الأرقام، أو أي نص للبحث السريع
bot.on("text", async ctx => {
    const text = String(ctx.message.text || "").trim();
    if (!text || text.startsWith("/")) return;

    const id = extractGalleryId(text);
    if (id) {
        return sendGalleryCard(ctx, id);
    }

    sessions.set(ctx.from.id, { type: "quick", query: text, updatedAt: Date.now() });
    return ctx.reply(
        `🔎 كيف تريد البحث عن <code>${escapeHtml(truncate(text, 60))}</code>؟`,
        {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
                [
                    Markup.button.callback("📚 بحث بالعنوان", "qsearch:title"),
                    Markup.button.callback("🏷️ بحث بالتاغات", "qsearch:tag")
                ],
                [Markup.button.callback("🗑️ إلغاء", "dismiss")]
            ]).reply_markup
        }
    );
});

bot.catch((err, ctx) => {
    console.error("Telegraf error:", safeError(err), "update:", ctx && ctx.updateType);
});

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);

    if (currentJob) currentJob.cancelled = true;
    if (botStarted) bot.stop(signal);
    server.close(() => console.log("HTTP server closed"));
    setTimeout(() => process.exit(0), 5000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

bot.launch({ dropPendingUpdates: true })
    .then(async () => {
        botStarted = true;
        console.log("Telegram bot started");
        // تسجيل قائمة الأوامر الرسمية في واجهة تليجرام
        await bot.telegram
            .setMyCommands([
                { command: "search", description: "البحث بالتاغات" },
                { command: "title", description: "البحث بعنوان المعرض" },
                { command: "view", description: "فتح معرض بالمعرّف" },
                { command: "settings", description: "إعدادات الجودة وتقسيم PDF" },
                { command: "help", description: "دليل الاستخدام" }
            ])
            .catch(() => {});
    })
    .catch(err => {
        console.error("Telegram bot failed:", err);
        process.exitCode = 1;
    });
