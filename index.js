const { Telegraf, Markup, Input } = require("telegraf");
const { hitomi, Extension } = require("node-hitomi");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const http = require("http");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_TELEGRAM_ID);
const PORT = Number(process.env.PORT) || 3000;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!Number.isSafeInteger(OWNER_ID) || OWNER_ID <= 0) {
  throw new Error("OWNER_TELEGRAM_ID is missing or invalid");
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 9_000_000 }); // 2.5 ساعة بدل 90 ثانية

const CONFIG = {
  maxPagesPerPdf: 1,
  maxPagesPerJob: 400,
  maxImageBytes: 25 * 1024 * 1024,
  targetMin: 70 * 1024,
  targetMax: 120 * 1024,
  maxWidth: 1400,
  downloadRetries: 3,
  requestTimeout: 30000,
  maxConcurrentJobs: 1,
  maxPdfBytes: 45 * 1024 * 1024
};

let activeJobs = 0;
let shuttingDown = false;
const sessions = new Map();

// Health check server
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Bot is alive\n");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Health server listening on ${PORT}`); // تم إصلاح backticks
});

function isOwner(ctx) {
  return ctx.from && ctx.from.id === OWNER_ID;
}

bot.use(async (ctx, next) => {
  if (ctx.from && !isOwner(ctx)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery("هذا البوت خاص.").catch(() => {});
    if (ctx.message) return ctx.reply("هذا البوت مخصص لصاحبه فقط.");
    return;
  }
  if (shuttingDown) return;
  try {
    await next();
  } catch (err) {
    console.error("Update error:", err.message);
  }
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeError(err) { return String(err && err.message || "Unknown error").slice(0, 350); }

function extractGalleryId(text) {
  const input = String(text || "").trim();
  if (/^\d+$/.test(input)) {
    const id = Number(input);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  try {
    const url = new URL(input);
    if (!["hitomi.la", "www.hitomi.la"].includes(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/reader\/(\d+)\.html$/);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch (_) { return null; }
}

// ✅ إصلاح: استخدام Backticks مع الهروب الصحيح
function getSearchQuery(ctx) {
  return ctx.message.text.replace(/^\/search(?:@\w+)?\s*/i, "").trim();
}

function normalizeTitle(gallery) {
  // الطريقة الصحيحة حسب توثيق node-hitomi 9.x
  if (gallery && gallery.title && typeof gallery.title.display === "string") {
    return gallery.title.display;
  }
  // احتياطي في حال تغير الهيكل
  if (gallery && typeof gallery.title === "string") {
    return gallery.title;
  }
  return "Untitled gallery";
}

async function searchGalleries(query, mode) {
  const tags = hitomi.tags.parse(`language:english ${query}`);
  const options = { tags };
  if (mode === "title") options.title = query;
  const results = await hitomi.galleries.list(options);
  return Array.isArray(results) ? results : [];
}


function getGalleryIdFromResult(item) {
  const raw = item && (item.id || item.galleryid || item.galleryId);
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function makeResultKeyboard(results, page) {
  const start = page * 5;
  const current = results.slice(start, start + 5);
  const rows = current.map((item, index) => {
    const id = getGalleryIdFromResult(item);
    const title = normalizeTitle(item);
    const label = `${start + index + 1}. ${title}`.slice(0, 55);
    if (!id) return null;
    return [Markup.button.callback(label, `gallery:${id}`)];
  }).filter(Boolean);

  const navigation = [];
  if (page > 0) navigation.push(Markup.button.callback("⬅️ السابق", `results:${page - 1}`));
  if (start + 5 < results.length) navigation.push(Markup.button.callback("التالي ➡️", `results:${page + 1}`));
  if (navigation.length) rows.push(navigation);
  return Markup.inlineKeyboard(rows);
}

async function sendSearchResults(ctx, query, mode, page = 0) {
  const results = await searchGalleries(query, mode);
  if (!results.length) return ctx.reply("لم أجد نتائج. جرّب عبارة أخرى.");
  const valid = results.filter(item => getGalleryIdFromResult(item)).slice(0, 50);
  if (!valid.length) return ctx.reply("لم أستطع قراءة معرفات النتائج.");
  sessions.set(ctx.from.id, { query, mode, results: valid });
  return ctx.reply(`نتائج البحث: ${query}\nعدد النتائج المعروضة: ${valid.length}`, makeResultKeyboard(valid, page));
}

bot.start(ctx => ctx.reply(
  "أهلًا بك.\n\n" +
  "/search blue archive - البحث بالتاغ\n" +
  "/title blue archive - البحث بالعنوان\n" +
  "/view 1916532 - فتح معرض بالمعرف\n\n" +
  "أرسل رابط Hitomi لتحويل المعرض إلى PDF."
));

bot.help(ctx => ctx.reply(
  "/search كلمة البحث\n/title اسم المعرض\n/view معرف المعرض\n\n" +
  "يمكنك أيضًا إرسال رابط المعرض مباشرة."
));

bot.command("search", async ctx => {
  const query = getSearchQuery(ctx);
  if (!query) return ctx.reply("مثال:\n/search blue archive");
  await ctx.reply("🔎 جاري البحث بالتاغ...");
  try {
    await sendSearchResults(ctx, query, "tags");
  } catch (err) {
    console.error("Tag search error:", err);
    await ctx.reply("تعذر إكمال البحث.\n" + safeError(err));
  }
});

// ✅ إصلاح: الهروب الصحيح في regex
bot.command("title", async ctx => {
  const query = ctx.message.text.replace(/^\/title(?:@\w+)?\s*/i, "").trim();
  if (!query) return ctx.reply("مثال:\n/title blue archive");
  await ctx.reply("🔎 جاري البحث بالعنوان...");
  try {
    await sendSearchResults(ctx, query, "title");
  } catch (err) {
    console.error("Title search error:", err);
    await ctx.reply("تعذر إكمال البحث بالعنوان.\n" + safeError(err));
  }
});

bot.action(/^results:(\d+)$/, async ctx => {
  const page = Number(ctx.match[1]);
  const session = sessions.get(ctx.from.id);
  if (!session) return ctx.answerCbQuery("انتهت جلسة البحث. ابحث مجددًا.");
  await ctx.answerCbQuery();
  return ctx.editMessageReplyMarkup(makeResultKeyboard(session.results, page).reply_markup).catch(() => {});
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
  const raw = ctx.message.text.replace(/^\/view(?:@\w+)?\s*/i, "").trim();
  const id = extractGalleryId(raw);
  if (!id) return ctx.reply("استخدم:\n/view 1916532");
  return showOutputOptions(ctx, id);
});

// ✅ ضغط الصور (كما هو، لكنه الآن يستقبل WebP)
async function compressImage(input) {
  const metadata = await sharp(input, { limitInputPixels: 40000000 }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("تعذر قراءة أبعاد الصورة");

  let width = Math.min(metadata.width, CONFIG.maxWidth);
  let quality = 76;
  let best = null;

  for (let attempt = 0; attempt < 8; attempt++) {
    let output = await sharp(input, { limitInputPixels: 40000000 })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true, progressive: true })
      .toBuffer();

    if (output.length <= CONFIG.targetMax) {
      if (output.length >= CONFIG.targetMin || !best || output.length > best.length) best = output;
      if (output.length >= CONFIG.targetMin) return output;
    }
    if (!best || (output.length <= CONFIG.targetMax && output.length > best.length)) best = output;

    if (output.length > CONFIG.targetMax) {
      if (quality > 40) quality -= 8;
      else width = Math.max(500, Math.floor(width * 0.85));
    } else return output;
  }
  if (best) return best;
  throw new Error("تعذر ضغط الصورة");
}

// ✅ جلب المعرض والصور بالطريقة الجديدة
async function retrieveGalleryData(galleryId) {
  const gallery = await hitomi.galleries.retrieve(galleryId);
  if (!gallery) throw new Error("لم يتم العثور على المعرض");

  // الطريقة الصحيحة للحصول على قائمة الصور
  const images = gallery.getThumbnails();
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error("لم أجد صورًا في هذا المعرض.");
  }
  if (images.length > CONFIG.maxPagesPerJob) {
    throw new Error(`المعرض يحتوي على ${images.length} صفحة. الحد ${CONFIG.maxPagesPerJob}.`);
  }
  return { gallery, images };
}

// ✅ إنشاء PDF: تحويل WebP إلى JPEG أولاً
async function createPdf(buffers) {
  const pdf = await PDFDocument.create();
  for (const webpBuffer of buffers) {
    // الخطوة الحاسمة: تحويل WebP إلى JPEG ليتوافق مع pdf-lib
    const jpegBuffer = await sharp(webpBuffer).jpeg({ quality: 85 }).toBuffer();
    const metadata = await sharp(jpegBuffer).metadata();
    const width = metadata.width || 800;
    const height = metadata.height || 1200;
    const image = await pdf.embedJpg(jpegBuffer);
    const page = pdf.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: true }));
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries - 1) throw err;
      console.log(`Retry ${i + 1} after error: ${err.message}`);
      await sleep(3000); // انتظر 3 ثواني قبل المحاولة
    }
  }
}

async function processGallery(ctx, galleryId, mode) {
  if (activeJobs >= CONFIG.maxConcurrentJobs) {
    return ctx.reply("هناك عملية أخرى قيد التنفيذ. حاول بعد انتهائها.");
  }
  activeJobs++;

  try {
    const status = await ctx.reply(`📥 جاري جلب المعرض ${galleryId}...`);
    const { images } = await retrieveGalleryData(galleryId);
    const count = images.length;

    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      `🖼️ عدد الصفحات: ${count}\nجاري تجهيز الصور...`).catch(() => {});

    let completed = 0, failed = 0, buffers = [];
    const totalParts = Math.ceil(count / CONFIG.maxPagesPerPdf);

    for (let part = 0; part < totalParts; part++) {
      const start = part * CONFIG.maxPagesPerPdf;
      const end = Math.min(start + CONFIG.maxPagesPerPdf, count);
      buffers = [];

      for (let i = start; i < end; i++) {
        try {
          // ✅ جلب الصورة مباشرة كـ Uint8Array ثم تحويلها إلى Buffer
          const imageData = await images[i].fetch(Extension.Webp);
          const rawBuffer = Buffer.from(imageData);
          if (rawBuffer.length > CONFIG.maxImageBytes) throw new Error("حجم الصورة كبير جدًا");
          const compressed = await compressImage(rawBuffer);
          buffers.push(compressed);
          completed++;
        } catch (err) {
          failed++;
          console.error(`Page ${i + 1} failed:`, err.message);
        }

        if ((i + 1) % 5 === 0 || i + 1 === count) {
          await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
            `📥 جاري المعالجة\n` +
            `الصفحات المفحوصة: ${i + 1}/${count}\n` +
            `الصفحات الناجحة: ${completed}\n` +
            `الصفحات الفاشلة: ${failed}\n` +
            `الجزء: ${part + 1}/${totalParts}`).catch(() => {});
        }
        await sleep(100);
      }

      if (!buffers.length) continue;

      if (mode === "photos") {
        for (let i = 0; i < buffers.length; i += 10) {
          const chunk = buffers.slice(i, i + 10);
          const media = chunk.map((buffer, index) => ({
            type: "photo",
            media: Input.fromBuffer(buffer, `page_${start + i + index + 1}.jpg`)
          }));
          try {
            await ctx.replyWithMediaGroup(media);
          } catch (err) {
            console.error("Photo group error:", err.message);
            await ctx.reply("تعذر إرسال مجموعة صور.");
          }
          await sleep(500);
        }
      } else {
        let pdfBuffer;
        try {
          pdfBuffer = await createPdf(buffers);
        } catch (err) {
          console.error("PDF creation error:", err.message);
          await ctx.reply("فشل إنشاء ملف PDF لهذا الجزء.");
          continue;
        }

        if (pdfBuffer.length > CONFIG.maxPdfBytes) {
          await ctx.reply(`الجزء ${part + 1} أكبر من الحد المسموح. جرّب إرسال الصور.`);
          continue;
        }

        try {
          await withRetry(() => ctx.replyWithDocument(...));
        } catch (err) {
          console.error("PDF upload error:", err.message);
          await ctx.reply("فشل إرسال ملف PDF.");
        }
      }
      buffers = [];
      await sleep(300);
    }

    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      `✅ انتهت المعالجة\nالمعرض: ${galleryId}\nالصور الناجحة: ${completed}\nالصور الفاشلة: ${failed}`).catch(() => {});

  } catch (err) {
    console.error("Gallery job error:", err);
    await ctx.reply("❌ تعذرت معالجة المعرض:\n" + safeError(err));
  } finally {
    activeJobs--;
  }
}

// ✅ إضافة try/catch لطباعة الأخطاء الحقيقية
bot.action(/^pdf:(\d+)$/, async ctx => {
  await ctx.answerCbQuery("بدأت المعالجة");
  try {
    return await processGallery(ctx, Number(ctx.match[1]), "pdf");
  } catch (err) {
    console.error("PDF error:", err.message);
    await ctx.reply("فشل الإرسال. جاري إعادة المحاولة...").catch(() => {});
    // إعادة محاولة واحدة
    try {
      return await processGallery(ctx, Number(ctx.match[1]), "pdf");
    } catch (err2) {
      await ctx.reply("فشل الإرسال بعد إعادة المحاولة: " + err2.message).catch(() => {});
    }
  }
});

bot.action(/^photos:(\d+)$/, async ctx => {
  try {
    await ctx.answerCbQuery("بدأت المعالجة");
    return processGallery(ctx, Number(ctx.match[1]), "photos");
  } catch (err) {
    console.error("Photos action error:", err);
    await ctx.reply("حدث خطأ: " + err.message);
  }
});

bot.on("text", async ctx => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  const id = extractGalleryId(text);
  if (!id) return;
  return showOutputOptions(ctx, id);
});

bot.catch((err, ctx) => {
  console.error("Telegraf error:", err.message, "update:", ctx.updateType);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  bot.stop(signal);
  server.close(() => console.log("HTTP server closed"));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

bot.launch()
  .then(() => console.log("Telegram bot started"))
  .catch(err => {
    console.error("Telegram bot failed:", err);
    process.exitCode = 1;
  });