const dns = require("dns");
// 1. إجبار Node.js على تفضيل IPv4 لحل مشكلة socket hang up على Render
if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
}

const https = require("https");
const http = require("http");
const { Telegraf, Markup, Input } = require("telegraf");
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
    targetImageBytes: 150 * 1024,
    maxWidth: 1280,
    downloadRetries: 3,
    uploadRetries: 4,
    maxPdfBytes: 45 * 1024 * 1024,
    pdfPagesPerPart: 25,
    photoGroupSize: 10,
    maxSearchResults: 50,
    searchPageSize: 5,
    requestDelayMs: 200
};

// 3. إعداد Agent مخصص يجبر الاتصال على IPv4 ويمنع تعليق الـ Sockets الميتة
const telegramAgent = new https.Agent({
    keepAlive: false, // يمنع إعادة استخدام Socket أغلقه سيرفر تليجرام أثناء ضغط الصور
    family: 4,        // إجبار IPv4
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

let activeJobs = 0;
let shuttingDown = false;
let botStarted = false;

const sessions = new Map();
const runningJobs = new Set();

// Render health-check server
const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bot is alive\n");
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Health server listening on ${PORT}`);
});

function isOwner(ctx) {
    return Boolean(ctx.from && ctx.from.id === OWNER_ID);
}

bot.use(async (ctx, next) => {
    if (ctx.from && !isOwner(ctx)) {
        if (ctx.callbackQuery) {
            return ctx.answerCbQuery("هذا البوت خاص.").catch(() => {});
        }
        if (ctx.message) {
            return ctx.reply("هذا البوت مخصص لصاحبه فقط.").catch(() => {});
        }
        return;
    }

    if (shuttingDown) return;

    try {
        await next();
    } catch (err) {
        console.error("Middleware error:", safeError(err));
    }
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function safeError(err) {
    return String((err && (err.message || err)) || "Unknown error").slice(0, 500);
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

        if (host !== "hitomi.la" && host !== "www.hitomi.la") {
            return null;
        }

        const match = url.pathname.match(/^\/(?:reader|galleries|manga|doujinshi|cg|gamecg)\/.*?(?:(\d+))\.html$/i) ||
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

function normalizeTitle(item) {
    if (item && item.title && typeof item.title.display === "string") {
        return item.title.display;
    }
    if (item && typeof item.title === "string") {
        return item.title;
    }
    return "Untitled gallery";
}

function getGalleryIdFromResult(item) {
    const raw = item && (item.id || item.galleryid || item.galleryId);
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeTagSearchTerm(query) {
    return String(query || "")
        .trim()
        .replace(/\s+/g, "_")
        .replace(/:/g, ":");
}

function getTagString(tag) {
    return String(tag || "").trim();
}

async function searchTagCandidates(query) {
    const term = normalizeTagSearchTerm(query);
    if (!term) return [];

    const raw = await hitomi.tags.search(term);
    if (!Array.isArray(raw)) return [];

    return raw
        .map(entry => {
            if (!Array.isArray(entry) || !entry[0]) return null;
            return {
                tagText: getTagString(entry[0]),
                count: Number(entry[1]) || 0
            };
        })
        .filter(item => item && item.tagText)
        .slice(0, CONFIG.maxSearchResults);
}

async function searchGalleriesByTag(tagText) {
    const tags = hitomi.tags.parse(tagText);
    const refs = await hitomi.galleries.list({ tags });
    return Array.isArray(refs) ? refs : [];
}

async function searchGalleriesByTitle(query) {
    const refs = await hitomi.galleries.list({ title: query });
    return Array.isArray(refs) ? refs : [];
}

function makeTagKeyboard(tags, page = 0) {
    const start = page * CONFIG.searchPageSize;
    const current = tags.slice(start, start + CONFIG.searchPageSize);

    const rows = current.map((item, index) => {
        const label = `${start + index + 1}. ${item.tagText} (${item.count})`;
        return [Markup.button.callback(label.slice(0, 60), `tagpick:${start + index}`)];
    });

    const navigation = [];
    if (page > 0) {
        navigation.push(Markup.button.callback("⬅️ السابق", `tagpage:${page - 1}`));
    }
    if (start + CONFIG.searchPageSize < tags.length) {
        navigation.push(Markup.button.callback("التالي ➡️", `tagpage:${page + 1}`));
    }
    if (navigation.length) rows.push(navigation);

    return Markup.inlineKeyboard(rows);
}

function makeGalleryKeyboard(results, page = 0) {
    const start = page * CONFIG.searchPageSize;
    const current = results.slice(start, start + CONFIG.searchPageSize);

    const rows = current
        .map((item, index) => {
            const id = getGalleryIdFromResult(item);
            if (!id) return null;
            const label = `${start + index + 1}. ${normalizeTitle(item)}`;
            return [Markup.button.callback(label.slice(0, 60), `gallery:${id}`)];
        })
        .filter(Boolean);

    const navigation = [];
    if (page > 0) {
        navigation.push(Markup.button.callback("⬅️ السابق", `gallerypage:${page - 1}`));
    }
    if (start + CONFIG.searchPageSize < results.length) {
        navigation.push(Markup.button.callback("التالي ➡️", `gallerypage:${page + 1}`));
    }
    if (navigation.length) rows.push(navigation);

    return Markup.inlineKeyboard(rows);
}

async function showTagSearchResults(ctx, query) {
    const tags = await searchTagCandidates(query);
    if (!tags.length) {
        return ctx.reply("لم أجد تاغات مطابقة. جرّب كلمة أخرى.");
    }

    sessions.set(ctx.from.id, {
        type: "tags",
        query,
        tags,
        updatedAt: Date.now()
    });

    return ctx.reply(
        `🔎 نتائج التاغات: ${query}\nعدد النتائج: ${tags.length}\nاختر التاغ المطلوب:`,
        makeTagKeyboard(tags, 0)
    );
}

async function showGallerySearchResults(ctx, query, mode, results) {
    const valid = results
        .filter(item => getGalleryIdFromResult(item))
        .slice(0, CONFIG.maxSearchResults);

    if (!valid.length) {
        return ctx.reply("لم أجد معارض مطابقة.");
    }

    sessions.set(ctx.from.id, {
        type: "galleries",
        query,
        mode,
        results: valid,
        updatedAt: Date.now()
    });

    return ctx.reply(
        `نتائج البحث: ${query}\nعدد النتائج المعروضة: ${valid.length}`,
        makeGalleryKeyboard(valid, 0)
    );
}

bot.start(ctx =>
    ctx.reply(
        "أهلًا بك.\n\n" +
        "/search blue archive - البحث عن التاغات\n" +
        "/title blue archive - البحث بالعنوان\n" +
        "/view 1916532 - فتح معرض بالمعرف\n\n" +
        "أرسل رابط Hitomi لتحويل المعرض إلى PDF أو صور."
    )
);

bot.help(ctx =>
    ctx.reply(
        "/search كلمة البحث\n" +
        "/title اسم المعرض\n" +
        "/view معرف المعرض\n\n" +
        "يمكنك أيضًا إرسال رابط المعرض مباشرة."
    )
);

bot.command("search", async ctx => {
    const query = getCommandQuery(ctx, "search");
    if (!query) return ctx.reply("مثال:\n/search blue archive");

    await ctx.reply("🔎 جاري البحث عن التاغات...");
    try {
        await showTagSearchResults(ctx, query);
    } catch (err) {
        console.error("Tag search error:", safeError(err));
        await ctx.reply("تعذر إكمال البحث بالتاغ.\n" + safeError(err));
    }
});

bot.command("title", async ctx => {
    const query = getCommandQuery(ctx, "title");
    if (!query) return ctx.reply("مثال:\n/title blue archive");

    await ctx.reply("🔎 جاري البحث بالعنوان...");
    try {
        const results = await searchGalleriesByTitle(query);
        await showGallerySearchResults(ctx, query, "title", results);
    } catch (err) {
        console.error("Title search error:", safeError(err));
        await ctx.reply("تعذر إكمال البحث بالعنوان.\n" + safeError(err));
    }
});

bot.action(/^tagpage:(\d+)$/, async ctx => {
    const page = Number(ctx.match[1]);
    const session = sessions.get(ctx.from.id);

    if (!session || session.type !== "tags") {
        return ctx.answerCbQuery("انتهت جلسة البحث. ابحث مجددًا.");
    }

    await ctx.answerCbQuery();
    return ctx.editMessageReplyMarkup(makeTagKeyboard(session.tags, page).reply_markup).catch(() => {});
});

bot.action(/^tagpick:(\d+)$/, async ctx => {
    const index = Number(ctx.match[1]);
    const session = sessions.get(ctx.from.id);

    if (!session || session.type !== "tags" || !session.tags[index]) {
        return ctx.answerCbQuery("انتهت جلسة البحث. ابحث مجددًا.");
    }

    await ctx.answerCbQuery("جاري جلب المعارض...");
    const selectedTag = session.tags[index].tagText;

    try {
        const results = await searchGalleriesByTag(selectedTag);
        await showGallerySearchResults(ctx, selectedTag, "tags", results);
    } catch (err) {
        console.error("Gallery tag search error:", safeError(err));
        await ctx.reply("تعذر جلب المعارض لهذا التاغ.\n" + safeError(err));
    }
});

bot.action(/^gallerypage:(\d+)$/, async ctx => {
    const page = Number(ctx.match[1]);
    const session = sessions.get(ctx.from.id);

    if (!session || session.type !== "galleries") {
        return ctx.answerCbQuery("انتهت جلسة البحث. ابحث مجددًا.");
    }

    await ctx.answerCbQuery();
    return ctx.editMessageReplyMarkup(makeGalleryKeyboard(session.results, page).reply_markup).catch(() => {});
});

bot.action(/^gallery:(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    return showOutputOptions(ctx, Number(ctx.match[1]));
});

async function showOutputOptions(ctx, galleryId) {
    return ctx.reply(
        `المعرض: ${galleryId}\nاختر طريقة الإخراج:`,
        Markup.inlineKeyboard([
            [Markup.button.callback("📕 PDF مضغوط", `pdf:${galleryId}`)],
            [Markup.button.callback("🖼️ إرسال الصور", `photos:${galleryId}`)]
        ])
    );
}

bot.command("view", async ctx => {
    const raw = getCommandQuery(ctx, "view");
    const id = extractGalleryId(raw);

    if (!id) return ctx.reply("استخدم:\n/view 1916532");
    return showOutputOptions(ctx, id);
});

bot.on("text", async ctx => {
    const text = String(ctx.message.text || "").trim();
    if (text.startsWith("/")) return;

    const id = extractGalleryId(text);
    if (!id) return;

    return showOutputOptions(ctx, id);
});

async function withRetry(fn, retries = CONFIG.downloadRetries, label = "operation") {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const errMsg = safeError(err);
            console.error(`${label} failed (${attempt}/${retries}):`, errMsg);

            // التعامل مع Rate Limit الخاص بتليجرام (429 Too Many Requests)
            const retryAfter = err && err.response && err.response.parameters && err.response.parameters.retry_after;
            if (retryAfter) {
                await sleep((Number(retryAfter) + 1) * 1000);
                continue;
            }

            if (attempt < retries) {
                await sleep(Math.min(2500 * attempt, 10000));
            }
        }
    }

    throw lastError || new Error(`${label} failed`);
}

async function retrieveGalleryData(galleryId) {
    const gallery = await withRetry(
        () => hitomi.galleries.retrieve(galleryId),
        CONFIG.downloadRetries,
        "Gallery retrieval"
    );

    if (!gallery) throw new Error("لم يتم العثور على المعرض");

    const images = gallery.files;
    if (!Array.isArray(images) || images.length === 0) {
        throw new Error("لم يتم العثور على صفحات المعرض (gallery.files فارغة).");
    }

    if (images.length > CONFIG.maxPagesPerJob) {
        throw new Error(`المعرض يحتوي على ${images.length} صفحة. الحد الحالي ${CONFIG.maxPagesPerJob}.`);
    }

    return { gallery, images };
}

async function fetchImageBuffer(image, pageNumber) {
    const data = await withRetry(
        () => image.fetch(Extension.Webp),
        CONFIG.downloadRetries,
        `Image ${pageNumber} download`
    );

    const buffer = Buffer.from(data);
    if (!buffer.length) {
        throw new Error(`الصورة ${pageNumber} فارغة`);
    }
    if (buffer.length > CONFIG.maxImageBytes) {
        throw new Error(`حجم الصورة ${pageNumber} كبير جدًا`);
    }

    return buffer;
}

/**
 * 4. ضغط الصورة بخطوة أو خطوتين كحد أقصى بدلاً من 12 محاولة تستهلك المعالج والرام،
 * مع إرجاع الأبعاد مباشرة لتجنب فك تشفير الصورة مجدداً داخل createPdf.
 */
async function compressImage(input) {
    const pipeline = sharp(input, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: CONFIG.maxWidth, withoutEnlargement: true })
        .flatten({ background: "#ffffff" });

    let { data, info } = await pipeline
        .jpeg({ quality: 72, mozjpeg: true, progressive: true })
        .toBuffer({ resolveWithObject: true });

    // إذا كان الحجم لا يزال كبيراً جداً، نقوم بتمريرة ثانية سريعة وأخيرة
    if (data.length > CONFIG.targetImageBytes * 1.6) {
        const smallerWidth = Math.max(600, Math.floor((info.width || CONFIG.maxWidth) * 0.78));
        const secondPass = await sharp(data)
            .resize({ width: smallerWidth, withoutEnlargement: true })
            .jpeg({ quality: 55, mozjpeg: true, progressive: true })
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

/**
 * 5. إنشاء الـ PDF مباشرة من الـ JPEG Buffers المضغوطة دون استدعاء sharp مرة أخرى!
 */
async function createPdf(processedImages) {
    const pdf = await PDFDocument.create();

    for (let index = 0; index < processedImages.length; index++) {
        const { buffer, width, height } = processedImages[index];
        const image = await pdf.embedJpg(buffer);
        const page = pdf.addPage([width, height]);

        page.drawImage(image, {
            x: 0,
            y: 0,
            width,
            height
        });
    }

    return Buffer.from(await pdf.save({ useObjectStreams: true }));
}

async function uploadPdf(chatId, pdfBuffer, galleryId, partNumber, totalParts) {
    if (pdfBuffer.length > CONFIG.maxPdfBytes) {
        throw new Error(
            `حجم PDF (${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB) تجاوز حد البوت الآمن.`
        );
    }

    await withRetry(async () => {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("caption", `📕 المعرض ${galleryId} — الجزء ${partNumber}/${totalParts}`);
        form.append(
            "document",
            new Blob([pdfBuffer], { type: "application/pdf" }),
            `hitomi_${galleryId}_part_${partNumber}.pdf`
        );

        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(120_000)
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
            const err = new Error(data.description || `HTTP ${res.status}`);
            err.response = data; // لكي تلتقطها دالة withRetry في حال وجود retry_after
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
                `hitomi_${galleryId}_page_${firstPageNumber + index}.jpg`
            );
            return {
                type: "photo",
                media: `attach://${fieldName}`
            };
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


async function updateProgress(chatId, messageId, text) {
    return bot.telegram
        .editMessageText(chatId, messageId, undefined, text)
        .catch(() => {});
}

async function processGallery(chatId, userId, galleryId, mode) {
    if (activeJobs >= 1) {
        await bot.telegram.sendMessage(chatId, "هناك عملية أخرى قيد التنفيذ. انتظر حتى تنتهي.").catch(() => {});
        return;
    }

    activeJobs++;
    const jobKey = `${userId}:${galleryId}:${mode}`;
    runningJobs.add(jobKey);

    let completed = 0;
    let failed = 0;
    let statusMessage = null;

    try {
        statusMessage = await bot.telegram.sendMessage(chatId, `📥 جاري جلب المعرض ${galleryId}...`);

        const { gallery, images } = await retrieveGalleryData(galleryId);
        const total = images.length;
        const title = normalizeTitle(gallery);

        await updateProgress(
            chatId,
            statusMessage.message_id,
            `📚 ${title}\n🖼️ عدد الصفحات: ${total}\nجاري المعالجة...`
        );

        if (mode === "photos") {
            for (let start = 0; start < total; start += CONFIG.photoGroupSize) {
                const end = Math.min(start + CONFIG.photoGroupSize, total);
                const group = [];

                for (let i = start; i < end; i++) {
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

                if (group.length) {
                    await uploadPhotoGroup(chatId, group, galleryId, start + 1);
                    group.length = 0; // تحرير الرام فوراً
                }

                await updateProgress(
                    chatId,
                    statusMessage.message_id,
                    `📥 جاري المعالجة\n` +
                    `الصفحات: ${Math.min(end, total)}/${total}\n` +
                    `الناجحة: ${completed}\n` +
                    `الفاشلة: ${failed}`
                );
            }
        } else {
            const totalParts = Math.ceil(total / CONFIG.pdfPagesPerPart);

            for (let part = 0; part < totalParts; part++) {
                const start = part * CONFIG.pdfPagesPerPart;
                const end = Math.min(start + CONFIG.pdfPagesPerPart, total);
                const processedImages = [];

                for (let i = start; i < end; i++) {
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

                if (processedImages.length) {
                    const pdfBuffer = await createPdf(processedImages);
                    processedImages.length = 0; // تحرير صور الجزء من الرام قبل الرفع

                    console.log(
                        `PDF part ${part + 1}/${totalParts}: ` +
                        `${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`
                    );

                    await uploadPdf(
                        chatId,
                        pdfBuffer,
                        galleryId,
                        part + 1,
                        totalParts
                    );
                }

                await updateProgress(
                    chatId,
                    statusMessage.message_id,
                    `📥 جاري المعالجة\n` +
                    `الصفحات: ${Math.min(end, total)}/${total}\n` +
                    `الناجحة: ${completed}\n` +
                    `الفاشلة: ${failed}\n` +
                    `الجزء: ${part + 1}/${totalParts}`
                );
            }
        }

        await updateProgress(
            chatId,
            statusMessage.message_id,
            `✅ انتهت المعالجة\n` +
            `المعرض: ${galleryId}\n` +
            `عدد الصفحات: ${images.length}\n` +
            `الصور الناجحة: ${completed}\n` +
            `الصور الفاشلة: ${failed}`
        );
    } catch (err) {
        console.error("Gallery job error:", err);
        await bot.telegram
            .sendMessage(chatId, "❌ تعذرت معالجة المعرض:\n" + safeError(err))
            .catch(() => {});
    } finally {
        activeJobs = Math.max(0, activeJobs - 1);
        runningJobs.delete(jobKey);
    }
}

bot.action(/^pdf:(\d+)$/, async ctx => {
    await ctx.answerCbQuery("بدأت المعالجة").catch(() => {});
    const galleryId = Number(ctx.match[1]);

    if (activeJobs >= 1) {
        return ctx.reply("هناك عملية أخرى قيد التنفيذ. حاول بعد انتهائها.");
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    processGallery(chatId, userId, galleryId, "pdf").catch(err => {
        console.error("Background PDF job error:", safeError(err));
    });
});

bot.action(/^photos:(\d+)$/, async ctx => {
    await ctx.answerCbQuery("بدأت المعالجة").catch(() => {});
    const galleryId = Number(ctx.match[1]);

    if (activeJobs >= 1) {
        return ctx.reply("هناك عملية أخرى قيد التنفيذ. حاول بعد انتهائها.");
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    processGallery(chatId, userId, galleryId, "photos").catch(err => {
        console.error("Background photo job error:", safeError(err));
    });
});

bot.catch((err, ctx) => {
    console.error(
        "Telegraf error:",
        safeError(err),
        "update:",
        ctx && ctx.updateType
    );
});

async function shutdown(signal) {
    if (shuttingDown) return;

    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);

    if (botStarted) {
        bot.stop(signal);
    }

    server.close(() => {
        console.log("HTTP server closed");
    });

    setTimeout(() => process.exit(0), 5000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

bot.launch({ dropPendingUpdates: true })
    .then(() => {
        botStarted = true;
        console.log("Telegram bot started");
    })
    .catch(err => {
        console.error("Telegram bot failed:", err);
        process.exitCode = 1;
    });
