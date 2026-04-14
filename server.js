import express from "express";
import multer from "multer";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function fallbackAnalysis(title = "") {
  return {
    score: 6,
    risk_level: "בינונית",
    item_type: "לא זוהה בוודאות",
    category: "general",
    brand: "לא זוהה",
    estimated_model: title || "לא זוהה",
    year: null,
    visual_condition: "לא זוהה",
    warnings: ["לא בוצע ניתוח AI מלא. בדוק שהוגדר OPENAI_API_KEY תקין."],
    positives: [],
    questions_to_ask: [
      "אפשר לקבל תמונות נוספות?",
      "יש פגמים או תיקונים שכדאי לדעת עליהם?",
      "יש מסמך, קבלה או היסטוריית טיפולים?"
    ],
    summary: "המערכת לא הצליחה לבצע ניתוח מלא, ולכן מוצגת תשובת גיבוי.",
    estimated_price_range: { min: 0, max: 0 },
    price_position: "לא זוהה"
  };
}

function normalizeAnalysis(data) {
  return {
    score: Number(data.score ?? 0),
    risk_level: data.risk_level || "לא זוהה",
    item_type: data.item_type || "לא זוהה",
    category: data.category || "general",
    brand: data.brand || "לא זוהה",
    estimated_model: data.estimated_model || "לא זוהה",
    year: data.year ?? null,
    visual_condition: data.visual_condition || "לא זוהה",
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    positives: Array.isArray(data.positives) ? data.positives : [],
    questions_to_ask: Array.isArray(data.questions_to_ask) ? data.questions_to_ask : [],
    summary: data.summary || "לא התקבל סיכום.",
    estimated_price_range: {
      min: Number(data.estimated_price_range?.min ?? 0),
      max: Number(data.estimated_price_range?.max ?? 0)
    },
    price_position: data.price_position || "לא זוהה"
  };
}

app.post("/analyze-screenshot", upload.single("screenshot"), async (req, res) => {
  try {
    const title = (req.body.title || "").trim();
    if (!req.file) return res.status(400).json({ error: "לא הועלה צילום מסך" });
    if (!process.env.OPENAI_API_KEY) return res.json(fallbackAnalysis(title));

    const mimeType = req.file.mimetype;
    if (!mimeType.startsWith("image/")) return res.status(400).json({ error: "הקובץ שהועלה אינו תמונה" });

    const base64Image = req.file.buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const prompt = `
נתח את תצלום המסך של המודעה והחזר JSON בלבד.

המטרה:
1. לזהות איזה פריט מוצג במודעה
2. להעריך דגם משוער אם אפשר
3. לתת חוות דעת חזותית בסיסית
4. לזהות נורות אזהרה
5. להציע שאלות למוכר
6. להחזיר ציון אמינות מ-1 עד 10
7. להעריך טווח מחיר סביר
8. להחזיר מיקום מחיר ביחס לשוק

אם אין ודאות, ציין זאת בזהירות.
אל תכתוב שום דבר מחוץ ל-JSON.

החזר במבנה:
{
  "score": number,
  "risk_level": "נמוכה|בינונית|גבוהה",
  "item_type": "string",
  "category": "car|phone|apartment|general",
  "brand": "string",
  "estimated_model": "string",
  "year": number,
  "visual_condition": "string",
  "warnings": ["string"],
  "positives": ["string"],
  "questions_to_ask": ["string"],
  "summary": "string",
  "estimated_price_range": {
    "min": number,
    "max": number
  },
  "price_position": "זול|הוגן|מעט יקר|יקר"
}

כותרת אופציונלית מהמשתמש:
${title}
`;

    const response = await client.responses.create({
      model: "gpt-5.4",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: dataUrl }
        ]
      }]
    });

    const text = response.output_text?.trim();
    if (!text) return res.status(500).json({ error: "לא התקבלה תשובה מהמודל" });

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      console.error("Raw model output:", text);
      return res.status(500).json({ error: "המודל החזיר תשובה שלא הייתה JSON תקין" });
    }

    return res.json(normalizeAnalysis(parsed));
  } catch (error) {
    console.error("Analyze screenshot error:", error);
    if (error?.status === 401) return res.status(500).json({ error: "מפתח ה-API לא תקין או לא מורשה" });
    if (error?.status === 429) return res.status(500).json({ error: "חרגת ממכסת השימוש או מקצב הבקשות" });
    return res.status(500).json({ error: "אירעה שגיאה בניתוח צילום המסך" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
