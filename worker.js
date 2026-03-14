// PriceSarkar — Cloudflare Worker
// Kaam: 
//   1. Kisi bhi product URL (short/long) se product title fetch karo
//   2. Woh exact title Groq ko do taaki sahi product identify ho
//   3. Groq API proxy (key safe)

export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Only POST allowed", { status: 405 });
    }

    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: "GROQ_API_KEY environment variable set nahi hai" } }),
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    try {
      const body = await request.json();

      // ── PRODUCT TITLE FETCH ──
      let fetchedTitle = "";
      let fetchedDesc = "";

      if (body.productUrl) {
        try {
          const pageRes = await fetch(body.productUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
            },
            redirect: "follow",
          });

          const html = await pageRes.text();
          const finalUrl = pageRes.url; // redirect ke baad actual URL

          // === Amazon ===
          // Method 1: #productTitle
          const amzSpan = html.match(/id="productTitle"[^>]*>\s*([\s\S]{5,300}?)\s*<\/span>/i);
          if (amzSpan) fetchedTitle = amzSpan[1].replace(/\s+/g, " ").trim();

          // Method 2: og:title
          if (!fetchedTitle) {
            const og = html.match(/property="og:title"\s+content="([^"]{5,300})"/i)
                      || html.match(/content="([^"]{5,300})"\s+property="og:title"/i);
            if (og) fetchedTitle = og[1].replace(/\s*[:\-|]\s*(Amazon|Flipkart|Meesho|Myntra|JioMart)\.?(in|com)?/gi, "").trim();
          }

          // Method 3: <title>
          if (!fetchedTitle) {
            const titleTag = html.match(/<title[^>]*>([\s\S]{5,400}?)<\/title>/i);
            if (titleTag) {
              fetchedTitle = titleTag[1]
                .replace(/\s*[:\-|]\s*(Amazon|Flipkart|Meesho|Myntra|JioMart|Buy Online|Shop Online)[\s\S]*/gi, "")
                .replace(/Buy\s+/i, "")
                .replace(/\s+/g, " ")
                .trim()
                .substring(0, 250);
            }
          }

          // === Flipkart ===
          if (!fetchedTitle && finalUrl.includes("flipkart")) {
            const fk = html.match(/class="B_NuCI"[^>]*>([\s\S]{5,300}?)<\/span>/i)
                     || html.match(/"title"\s*:\s*"([^"]{10,300})"/i);
            if (fk) fetchedTitle = fk[1].trim();
          }

          // og:description for extra specs context
          const ogDesc = html.match(/property="og:description"\s+content="([^"]{10,400})"/i)
                       || html.match(/content="([^"]{10,400})"\s+property="og:description"/i);
          if (ogDesc) fetchedDesc = ogDesc[1].trim().substring(0, 300);

        } catch(e) {
          fetchedTitle = "";
        }
      }

      // ── INJECT FETCHED TITLE INTO PROMPT ──
      const messages = body.messages || [];
      if (fetchedTitle && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "user") {
          lastMsg.content = lastMsg.content +
            `\n\n=== FETCHED FROM PRODUCT PAGE ===\nEXACT PRODUCT TITLE: ${fetchedTitle}` +
            (fetchedDesc ? `\nPRODUCT DESCRIPTION: ${fetchedDesc}` : "") +
            `\n\nUSE THIS EXACT TITLE to identify the product. Do not guess.`;
        }
      }

      // ── GROQ API CALL ──
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: body.model || "llama-3.1-8b-instant",
          messages,
          temperature: body.temperature || 0.7,
          max_tokens: body.max_tokens || 2000,
        }),
      });

      const data = await groqRes.json();
      if (fetchedTitle) data._fetchedTitle = fetchedTitle;

      return new Response(JSON.stringify(data), {
        status: groqRes.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });

    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err.message || "Worker error" } }),
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
  },
};
