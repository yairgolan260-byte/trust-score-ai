import express from "express";
import multer from "multer";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static("public"));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/analyze-screenshot", upload.single("screenshot"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "no file" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.json({score:5,summary:"no api key"});
    }

    const base64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${req.file.mimetype};base64,${base64}`;

    const response = await client.responses.create({
      model: "gpt-5.4",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "נתח את המוצר בתמונה ותן JSON עם score ו summary" },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ]
    });

    const text = response.output_text || "{}";

    res.json({result:text});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:"fail"});
  }
});

app.get("*",(req,res)=>{
  res.sendFile(new URL("./public/index.html", import.meta.url).pathname);
});

app.listen(process.env.PORT||3000);
