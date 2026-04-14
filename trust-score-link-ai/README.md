# Trust Score AI - Listing URL Extractor

אפליקציית Node.js + HTML שמקבלת קישור למודעה, מחלצת טקסט ותמונות מהעמוד, ואז מנתחת את המודעה עם AI.

## יכולות
- הדבקת קישור למודעה
- חילוץ title / description / text / image URLs
- ניתוח טקסט ותמונות
- זיהוי סוג פריט ודגם משוער
- ציון אמינות ונורות אזהרה
- חוות דעת חזותית ושאלות מומלצות למוכר
- Fallback ללא AI

## התקנה
```bash
npm install
cp .env.example .env
npm start
```

## פריסה ל-Render
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variable: `OPENAI_API_KEY=...`

## הערות
- לא כל אתר יאפשר חילוץ מלא. חלק מהאתרים משתמשים בהגנות, JS דינמי או חסימות נגד scraping.
- המערכת נותנת אינדיקציות וחיווי זהיר בלבד, ולא קביעה חד-משמעית.