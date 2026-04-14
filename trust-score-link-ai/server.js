
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import cheerio from "cheerio";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function normalizeWhitespace(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function toAbsoluteUrl(baseUrl, maybeRelative) {
  try {
    return new URL(maybeRelative, baseUrl).href;
  } catch {
    return null;
  }
}

function uniqueValidHttpUrls(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== "string") continue;
    if (!/^https?:\/\//i.test(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function extractTextBlocks($) {
  const selectors = [
    "meta[property='og:title']",
    "meta[name='description']",
    "meta[property='og:description']",
    "title",
    "h1",
    "h2",
    "[class*='title']",
    "[class*='description']",
    "[class*='desc']",
    "[class*='price']",
    "[data-testid*='title']",
    "[data-testid*='description']"
  ];

  const chunks = [];
  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const tag = ($el.get(0)?.tagName || "").toLowerCase();
      let value = "";
      if (tag === "meta") value = $el.attr("content") || "";
      else value = $el.text() || "";
      value = normalizeWhitespace(value);
      if (value && value.length > 2) chunks.push(value);
    });
  }

  $("script[type='application/ld+json']").each((_, el) => {
    const text = normalizeWhitespace($(el).text() || "");
    if (text) chunks.push(text);
  });

  return Array.from(new Set(chunks)).slice(0, 40);
}

function extractPriceFromText(text = "") {
  const matches = text.match(/(?:₪|ש\"ח|שח)?\s?(\d{1,3}(?:[,\.\s]\d{3})+|\d{4,7})/g);
  if (!matches || !matches.length) return null;
  const nums = matches.map(m => m.replace(/[^\d]/g, "")).map(Number).filter(n => Number.isFinite(n) && n > 99);
  return nums.length ? nums[0] : null;
}

async function extractListingData(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TrustScoreBot/1.0)"
    },
    maxRedirects: 5
  });

  const html = response.data;
  const $ = cheerio.load(html);

  const title =
    normalizeWhitespace($("meta[property='og:title']").attr("content")) ||
    normalizeWhitespace($("title").first().text()) ||
    normalizeWhitespace($("h1").first().text()) ||
    "";

  const description =
    normalizeWhitespace($("meta[property='og:description']").attr("content")) ||
    normalizeWhitespace($("meta[name='description']").attr("content")) ||
    normalizeWhitespace($("h1").first().text() + " " + $("h2").first().text()) ||
    "";

  const imageCandidates = [];
  $("meta[property='og:image'], meta[name='twitter:image']").each((_, el) => {
    imageCandidates.push(toAbsoluteUrl(url, $(el).attr("content")));
  });

  $("img").each((_, el) => {
    const attrs = ["src", "data-src", "data-lazy-src", "data-original"];
    for (const attr of attrs) {
      const value = $(el).attr(attr);
      const abs = toAbsoluteUrl(url, value);
      if (abs) imageCandidates.push(abs);
    }
  });

  const images = uniqueValidHttpUrls(imageCandidates).slice(0, 5);
  const textBlocks = extractTextBlocks($);
  const longText = normalizeWhitespace(textBlocks.join(" ").slice(0, 6000));
  const detectedPrice = extractPriceFromText(longText);

  return {
    source_url: url,
    extracted_title: title,
    extracted_description: description,
    extracted_text: longText,
    image_urls: images,
    detected_price: detectedPrice
  };
}

function fallbackRuleBasedAnalysis(payload) {
  const positives = [];
  const warnings = [];
  let score = 0;

  const title = payload.title || "";
  const description = payload.description || payload.extracted_text || "";
  const price = Number(payload.price || payload.detected_price || 0);
  const marketPrice = Number(payload.marketPrice || 0);
  const imageUrls = Array.isArray(payload.imageUrls) ? payload.imageUrls : [];
  const phoneVerified = payload.phoneVerified === "yes";

  if (title.length >= 8) { score += 1.2; positives.push("יש כותרת ברורה למודעה"); }
  else warnings.push("הכותרת קצרה או חסרה");

  if (description.length >= 120) { score += 2; positives.push("יש תיאור מפורט יחסית"); }
  else if (description.length >= 60) { score += 1; warnings.push("התיאור בינוני ויכול להיות מפורט יותר"); }
  else warnings.push("התיאור קצר מאוד");

  if (price > 0) { score += 1.5; positives.push("נמצא מחיר במודעה"); }
  else warnings.push("לא זוהה מחיר ברור");

  if (price > 0 && marketPrice > 0) {
    const diff = Math.abs(price - marketPrice) / marketPrice;
    if (diff <= 0.1) { score += 2.2; positives.push("המחיר קרוב למחיר השוק"); }
    else if (diff <= 0.2) { score += 1; warnings.push("המחיר מעט חריג ביחס לשוק"); }
    else warnings.push("המחיר חריג משמעותית ביחס לשוק");
  }

  if (imageUrls.length >= 5) { score += 2; positives.push("יש כמות טובה של תמונות"); }
  else if (imageUrls.length >= 2) { score += 1; warnings.push("יש מעט תמונות יחסית"); }
  else warnings.push("מעט מאוד תמונות זמינות לניתוח");

  if (phoneVerified) { score += 1.6; positives.push("המוכר סימן טלפון מאומת"); }
  else warnings.push("אין אימות טלפון");

  score = Math.max(1, Math.min(10, Number(score.toFixed(1))));
  let risk_level = "גבוהה";
  if (score >= 8) risk_level = "נמוכה";
  else if (score >= 5.5) risk_level = "בינונית";

  return {
    score,
    risk_level,
    positives,
    warnings,
    detected_item_type: "לא זוהה בוודאות",
    estimated_model: "לא זוהה",
    visual_opinion: imageUrls.length ? "יש תמונות, אבל הניתוח החזותי המתקדם זמין רק עם חיבור AI." : "לא נמסרו מספיק תמונות לניתוח חזותי.",
    recommended_questions: [
      "אפשר לקבל תמונה נוספת מקרוב של המוצר או הרכב?",
      "יש מסמך, קבלה או הוכחת בעלות?",
      "יש פגמים, תיקונים או בעיות שלא צוינו?"
    ],
    summary: `המודעה קיבלה ציון ${score}/10 על בסיס נתונים שחולצו מהעמוד והמידע שהוזן. זהו חיווי ראשוני בלבד.`
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasOpenAI: Boolean(client) });
});

app.post("/api/extract", async (req, res) => {
  try {
    const { listingUrl } = req.body;
    if (!listingUrl || typeof listingUrl !== "string") {
      return res.status(400).json({ error: "Missing listingUrl" });
    }
    const extracted = await extractListingData(listingUrl);
    return res.json(extracted);
  } catch (error) {
    console.error("Extract error:", error?.message || error);
    return res.status(500).json({ error: "Failed to extract listing", details: error?.message || "Unknown error" });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const payload = req.body || {};
    const imageUrls = Array.isArray(payload.imageUrls) ? payload.imageUrls.slice(0, 5) : [];

    if (!client) {
      return res.json({ result: fallbackRuleBasedAnalysis(payload), mode: "fallback" });
    }

    const content = [{
      type: "input_text",
      text: `
אתה מנתח מודעות מכירה בעברית.
תן חיווי זהיר בלבד. אל תכתוב קביעות משפטיות או עובדתיות מוחלטות.
אם אינך בטוח, כתוב "נראה", "ייתכן", "לא ניתן לקבוע בוודאות".
החזר JSON בלבד לפי הסכמה.

פרטי המודעה:
כותרת: ${payload.title || ""}
תיאור: ${payload.description || payload.extracted_text || ""}
קטגוריה: ${payload.category || ""}
מחיר: ${payload.price || payload.detected_price || ""}
מחיר שוק משוער: ${payload.marketPrice || ""}
טלפון מאומת: ${payload.phoneVerified || "no"}
מקור: ${payload.source_url || ""}

מטרות:
1. להעריך ציון אמינות 1-10
2. לזהות סוג פריט
3. אם אפשר, להעריך דגם או גרסה משוערת
4. לתת חוות דעת חזותית זהירה על מצב הפריט או הרכב
5. למצוא חוסר התאמה אפשרי בין התמונות לטקסט
6. להציע 3-5 שאלות טובות למוכר
7. לכתוב סיכום קצר בעברית
`
    }];

    for (const imageUrl of imageUrls) {
      content.push({ type: "input_image", image_url: imageUrl, detail: "low" });
    }

    const response = await client.responses.create({
      model: "gpt-5.4",
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "listing_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              score: { type: "number" },
              risk_level: { type: "string", enum: ["נמוכה", "בינונית", "גבוהה"] },
              positives: { type: "array", items: { type: "string" } },
              warnings: { type: "array", items: { type: "string" } },
              detected_item_type: { type: "string" },
              estimated_model: { type: "string" },
              visual_opinion: { type: "string" },
              recommended_questions: { type: "array", items: { type: "string" } },
              summary: { type: "string" }
            },
            required: ["score", "risk_level", "positives", "warnings", "detected_item_type", "estimated_model", "visual_opinion", "recommended_questions", "summary"]
          }
        }
      }
    });

    let parsed;
    try {
      parsed = JSON.parse(response.output_text || "{}");
    } catch {
      parsed = fallbackRuleBasedAnalysis(payload);
    }

    parsed.score = Math.max(1, Math.min(10, Number(parsed.score || 5)));
    return res.json({ result: parsed, mode: "ai" });
  } catch (error) {
    console.error("Analyze error:", error?.message || error);
    return res.json({ result: fallbackRuleBasedAnalysis(req.body || {}), mode: "fallback_on_error", error: error?.message || "Unknown error" });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
