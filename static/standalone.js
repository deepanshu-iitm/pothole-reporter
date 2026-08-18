// The app engine: the entire pipeline on-device, no server anywhere.
// The page's api() delegates every call here.
(() => {
  const NATIVE = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());

  // Test harness (browser, non-native): ?key=sk-... seeds the key. Never runs in the APK.
  if (!NATIVE) {
    const k = new URLSearchParams(location.search).get("key");
    if (k) localStorage.setItem("openai_key", k);
  }

  const S = {
    get key() { return (localStorage.getItem("openai_key") || "").trim(); },
    get name() { return (localStorage.getItem("sender_name") || "").trim() || "A concerned citizen"; },
    get debug() { return localStorage.getItem("debug_mode") === "1"; },
  };

  const LANG = () => (localStorage.getItem("app_lang") === "kn" ? "kn" : "en");
  const PROGRESS = {
    en: { compress: "Compressing photo...", capture: "Capturing frame...",
          detect: "AI checking for potholes...", finalize: "Finalizing address and contract...",
          write: "Writing the complaint...", email: "Opening your email app..." },
    kn: { compress: "ಫೋಟೋ ಸಂಕುಚಿಸಲಾಗುತ್ತಿದೆ...", capture: "ಫ್ರೇಮ್ ಸೆರೆಹಿಡಿಯಲಾಗುತ್ತಿದೆ...",
          detect: "AI ಗುಂಡಿ ಪರಿಶೀಲಿಸುತ್ತಿದೆ...", finalize: "ವಿಳಾಸ ಮತ್ತು ಗುತ್ತಿಗೆ ಖಚಿತಪಡಿಸಲಾಗುತ್ತಿದೆ...",
          write: "ದೂರು ಬರೆಯಲಾಗುತ್ತಿದೆ...", email: "ನಿಮ್ಮ ಇಮೇಲ್ ಆ್ಯಪ್ ತೆರೆಯಲಾಗುತ್ತಿದೆ..." },
  };
  const pmsg = (k) => (PROGRESS[LANG()] && PROGRESS[LANG()][k]) || PROGRESS.en[k];

  const MODEL = "gpt-5-mini";
  const MIN_CONFIDENCE = 0.5;
  const DEDUPE_RADIUS_M = 15;
  const DEDUPE_WINDOW_S = 30 * 60;

  const OFFICERS = {
    "bengaluru central city corporation": ["Commissioner, Bengaluru Central City Corporation (BCCC)", "commissionerbccc@gmail.com"],
    "bengaluru east city corporation": ["Commissioner, Bengaluru East City Corporation (BECC)", "commissioner.becc@gmail.com"],
    "bengaluru north city corporation": ["Commissioner, Bengaluru North City Corporation (BNCC)", "bengalurunorthcitycorporation@gmail.com"],
    "bengaluru south city corporation": ["Commissioner, Bengaluru South City Corporation (BSCC)", "comm.south.gba@gmail.com"],
    "bengaluru west city corporation": ["Commissioner, Bengaluru West City Corporation (BWCC)", "commissioner.bwcc@gmail.com"],
  };
  const HQ = ["Commissioner, Greater Bengaluru Authority (HQ)", "comm@bbmp.gov.in"];

  // The officer directory and the bundled contracts are Bengaluru-only. Outside it
  // there is no authority this app can name, and guessing sends a citizen's complaint
  // to a body with no jurisdiction, so coverage is checked before anything is routed.
  const BLR = { minLat: 12.70, maxLat: 13.25, minLng: 77.25, maxLng: 77.90 };
  function inCoverage(lat, lng, address) {
    if (lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng)) {
      return lat >= BLR.minLat && lat <= BLR.maxLat && lng >= BLR.minLng && lng <= BLR.maxLng;
    }
    if (address) {
      const low = address.toLowerCase();
      return low.includes("bengaluru") || low.includes("bangalore");
    }
    return false; // no location at all: we cannot claim to know who is responsible
  }

  const DETECT_PROMPT = `You are inspecting a road photo taken in Bengaluru for a civic complaint app.

Decide whether the photo clearly shows a pothole on a road surface.
- Classify size like pizzas: small (below 30 cm wide), medium (30 to 60 cm), large (above 60 cm or a cluster).
- Beware of speed breakers: from a distance they can look like potholes. Set looks_like_speed_breaker accordingly, and if it is actually a speed breaker, is_pothole must be false.
- Shadows, manhole covers, wet patches, and road repair scars are NOT potholes.
- confidence is your 0 to 1 confidence in the is_pothole verdict. Be conservative: this triggers a government complaint.
- description: one or two factual sentences usable in a complaint (surface condition, position on the road, hazard posed).
- Some images are dashcam frames from a moving vehicle: moderate motion blur, low light, or a boosted-brightness look are normal; judge the road surface itself.`;

  // Key order is the streaming order: the verdict fields arrive before the
  // description, so the UI can show a result while the sentence is still being written.
  const ASSESS_SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["is_pothole", "size", "confidence", "looks_like_speed_breaker", "description"],
    properties: {
      is_pothole: { type: "boolean" },
      size: { type: ["string", "null"], enum: ["small", "medium", "large", null] },
      confidence: { type: "number" },
      looks_like_speed_breaker: { type: "boolean" },
      description: { type: "string" },
    },
  };
  const TENDER_SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["match_index", "confidence", "reason"],
    properties: {
      match_index: { type: ["integer", "null"] },
      confidence: { type: "number" },
      reason: { type: "string" },
    },
  };

  // ---------- OpenAI ----------
  const OAI_URL = "https://api.openai.com/v1/responses";
  const authHeaders = () => ({ "Content-Type": "application/json", "Authorization": `Bearer ${S.key}` });

  // Detection is a classification job, not an essay: left at its default the model
  // spends 200+ hidden reasoning tokens per photo before answering, which measured
  // as roughly 3.5 of the 6.5 seconds a verdict used to take.
  const withSpeedDefaults = (body) => ({ reasoning: { effort: "minimal" }, ...body });

  // Fatal means "fails the same way without streaming", so retrying plain is pointless.
  const fatal = (e) => { e.fatal = true; return e; };
  function mapStatus(res) {
    if (res.status === 401) return fatal(new Error("OpenAI rejected the API key. Check it in settings."));
    if (res.status === 429) return fatal(new Error("Rate limited by OpenAI. Try again in a minute."));
    return null;
  }

  async function oai(body) {
    if (!S.key) throw new Error("OpenAI API key missing. Tap the gear icon and paste it.");
    const res = await fetch(OAI_URL, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(withSpeedDefaults(body)),
    });
    const bad = mapStatus(res);
    if (bad) throw bad;
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const msg = (data.output || []).find((o) => o.type === "message");
    const text = msg && msg.content && msg.content.find((c) => c.type === "output_text");
    if (!text || !text.text) throw new Error("Empty model response.");
    return JSON.parse(text.text);
  }

  // Structured outputs stream their keys in schema order, so is_pothole and size land
  // well before the description does. onEarly fires on that partial verdict.
  // The early verdict must apply the same rule as the final one, or a low-confidence
  // true would announce a pothole the pipeline then rejects. A false needs no
  // confidence to be final, so the early "no" stays as fast as the flag itself.
  const peekVerdict = (partial) => {
    const m = /"is_pothole"\s*:\s*(true|false)/.exec(partial);
    if (!m) return null;
    if (m[1] === "false") return { is_pothole: false, size: null };
    const c = /"confidence"\s*:\s*([0-9]*\.?[0-9]+)/.exec(partial);
    if (!c) return null;
    const s = /"size"\s*:\s*(?:"(small|medium|large)"|null)/.exec(partial);
    return { is_pothole: parseFloat(c[1]) >= MIN_CONFIDENCE, size: s ? s[1] || null : null };
  };

  function drainSSE(chunk, state, onEarly) {
    state.buf += chunk;
    let i;
    while ((i = state.buf.indexOf("\n")) >= 0) {
      const line = state.buf.slice(0, i).trim();
      state.buf = state.buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(payload); } catch (e) { continue; }
      if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
        state.text += ev.delta;
        if (!state.early && onEarly) {
          const v = peekVerdict(state.text);
          if (v) { state.early = true; try { onEarly(v); } catch (e) {} }
        }
      }
    }
  }

  async function oaiStream(body, onEarly) {
    if (!S.key) throw new Error("OpenAI API key missing. Tap the gear icon and paste it.");
    const res = await fetch(OAI_URL, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify(withSpeedDefaults({ ...body, stream: true })),
    });
    const bad = mapStatus(res);
    if (bad) throw bad;
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${(await res.text()).slice(0, 160)}`);

    const state = { buf: "", text: "", early: false };
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        drainSSE(dec.decode(value, { stream: true }), state, onEarly);
      }
    } else {
      // Buffered transports (the native HTTP bridge) hand back the whole SSE body at once.
      drainSSE(await res.text(), state, onEarly);
    }
    drainSSE("\n", state, onEarly);
    if (!state.text) throw new Error("Empty model response.");
    return JSON.parse(state.text);
  }

  const fmt = (name, schema) => ({
    format: { type: "json_schema", name, schema, strict: true },
    verbosity: "low",
  });
  const progress = (m) => { try { window.dispatchEvent(new CustomEvent("pipeline-progress", { detail: m })); } catch (e) {} };
  const emitVerdict = (v) => { try { window.dispatchEvent(new CustomEvent("pipeline-verdict", { detail: v })); } catch (e) {} };

  let streamBroken = false;
  async function analyzeImage(dataUrl, prompt, name, schema, model, onEarly) {
    const body = {
      model,
      input: [{ role: "user", content: [
        { type: "input_image", image_url: dataUrl },
        { type: "input_text", text: prompt },
      ] }],
      text: fmt(name, schema),
    };
    if (!onEarly || streamBroken) return oai(body);
    try {
      return await oaiStream(body, onEarly);
    } catch (e) {
      // A bad key or a rate limit fails identically unstreamed, so surface those.
      if (e && e.fatal) throw e;
      // Anything else (a server that refuses stream:true, a transport that cannot
      // stream, a parse failure) must not cost us the verdict. Remember it, so the
      // wasted round trip is paid once per launch and not on every photo.
      streamBroken = true;
      return oai(body);
    }
  }

  // One warm TLS connection ahead of the first real call. Costs no tokens.
  let warmedAt = 0;
  async function prewarm() {
    if (!S.key || Date.now() - warmedAt < 60000) return;
    warmedAt = Date.now();
    try {
      await fetch("https://api.openai.com/v1/models?limit=1", { headers: authHeaders() });
    } catch (e) {}
  }

  // ---------- location ----------
  async function reverseGeocode(lat, lng) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&zoom=17`);
      if (!res.ok) return null;
      return (await res.json()).display_name || null;
    } catch (e) { return null; }
  }

  // Returns [null, null] when the pothole is outside the covered area. HQ stays the
  // fallback only *within* Bengaluru, where it genuinely has jurisdiction.
  function routeOfficer(address, covered) {
    if (!covered) return [null, null];
    if (address) {
      const low = address.toLowerCase();
      for (const [needle, officer] of Object.entries(OFFICERS)) {
        if (low.includes(needle)) return officer;
      }
    }
    return HQ;
  }

  function distMeters(lat1, lng1, lat2, lng2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }

  // ---------- tenders ----------
  let _tenders = null;
  async function tenders() {
    if (_tenders) return _tenders;
    try {
      const res = await fetch("tenders.json");
      _tenders = res.ok ? await res.json() : [];
    } catch (e) { _tenders = []; }
    return _tenders;
  }

  const TENDER_STOP = new Set(["road", "roads", "street", "cross", "main", "layout", "bengaluru", "bangalore",
    "karnataka", "india", "ward", "city", "corporation", "south", "north", "east",
    "west", "central", "urban", "sector", "stage", "block", "phase"]);

  async function matchTender(address) {
    if (!address || !S.key) return null;
    const tokens = new Set();
    for (const part of address.split(",").slice(0, 4)) {
      for (const w of part.trim().toLowerCase().replace(/[()]/g, " ").split(/\s+/)) {
        if (w.length > 2 && !TENDER_STOP.has(w)) tokens.add(w);
      }
    }
    if (!tokens.size) return null;
    const scored = [];
    for (const t of await tenders()) {
      const hay = (t.t + " " + t.loc).toLowerCase();
      let score = 0;
      for (const tok of tokens) if (hay.includes(tok)) score++;
      if (score >= 1) scored.push([score, t]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const candidates = scored.slice(0, 25).map((x) => x[1]);
    if (!candidates.length) return null;
    const listing = candidates.map((t, i) =>
      `${i}: ${t.t.slice(0, 150)} | ${t.loc} | contractor: ${t.c || "not named"} | awarded: ${t.d}`).join("\n");
    const prompt = `You match a pothole's location to Bengaluru road-work contracts.
The pothole's reverse-geocoded address is:
${address}

Candidate contracts (index: work description | division | contractor | awarded):
${listing}

Pick the single contract whose work description covers this exact road stretch or
its immediate locality (same layout, ward or named road). Road names repeat across
Bengaluru localities, so the locality and ward context must agree, not just the
road name. A ward-wide maintenance or pothole-filling contract for the pothole's
own layout or ward is a valid match. If no candidate clearly covers this location,
match_index must be null. confidence is your 0 to 1 confidence in the match.`;
    let m;
    try {
      // Minimal effort suits a verdict on one photo. Picking one contract out of 25
      // near-identical road-works descriptions is the opposite job, and it names a
      // real contractor in a complaint, so this call keeps room to think.
      m = await oai({
        model: MODEL, input: prompt,
        reasoning: { effort: "medium" },
        text: fmt("tender_match", TENDER_SCHEMA),
      });
    } catch (e) { return null; }
    if (!m || m.match_index === null || m.match_index < 0 || m.match_index >= candidates.length || m.confidence < 0.6) return null;
    const t = candidates[m.match_index];
    let warranty = "on record for this stretch";
    let warranty_code = "record";
    const dm = /^(\d{2})-(\d{2})-(\d{4})/.exec(t.d);
    if (dm) {
      const ageYears = (Date.now() - new Date(`${dm[3]}-${dm[2]}-${dm[1]}`).getTime()) / (365.25 * 24 * 3600 * 1000);
      if (ageYears <= 1) { warranty = "likely still within the defect liability period"; warranty_code = "dlp"; }
      else if (ageYears <= 3) { warranty = "possibly still within the maintenance period"; warranty_code = "maint"; }
    }
    const contractor = t.c || "contractor not named in the award record";
    return {
      tender_number: t.tn, contractor, title: t.t, published: t.d, warranty, warranty_code,
      note: `Probable contract: ${t.tn}, ${contractor}, awarded ${t.d}`,
    };
  }

  // ---------- drafting (English / Kannada) ----------
  function draftEmail(a, lat, lng, address, officerName, tender) {
    const kn = LANG() === "kn";
    const sizeName = (s) => (kn ? ({ small: "ಸಣ್ಣ", medium: "ಮಧ್ಯಮ", large: "ದೊಡ್ಡ" })[s] || s : s);
    const size = a.size ? sizeName(a.size) : (kn ? "ಗಾತ್ರ ನಿರ್ಧರಿಸದ" : "unclassified");
    const road = address ? address.split(",")[0].trim() : null;
    let locLines;
    if (lat != null) {
      const la = lat.toFixed(6), ln = lng.toFixed(6);
      locLines = kn
        ? `ಸ್ಥಳ: ${address || "ಕೆಳಗಿನ ನಿರ್ದೇಶಾಂಕ ನೋಡಿ"}\nನಿರ್ದೇಶಾಂಕಗಳು: ${la}, ${ln}\nನಕ್ಷೆ ಲಿಂಕ್: https://maps.google.com/?q=${la},${ln}`
        : `Location: ${address || "location attached below"}\nCoordinates: ${la}, ${ln}\nMap link: https://maps.google.com/?q=${la},${ln}`;
    } else {
      locLines = kn
        ? "ಸ್ಥಳ: ಸ್ವಯಂಚಾಲಿತವಾಗಿ ನಿರ್ಧರಿಸಲಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಲಗತ್ತಿಸಿದ ಫೋಟೋ ನೋಡಿ."
        : "Location: could not be determined automatically. Please see the attached photo for landmarks.";
    }
    const subject = kn
      ? `ರಸ್ತೆ ಗುಂಡಿ ದೂರು: ${size} ಗುಂಡಿ` + (road ? ` (${road})` : "")
      : `Pothole complaint: ${size} pothole` + (road ? ` near ${road}` : "");
    let body = kn
      ? `ಮಾನ್ಯ ${officerName || "ಅಧಿಕಾರಿಗಳೇ"} ಅವರಿಗೆ,

ತುರ್ತು ದುರಸ್ತಿ ಅಗತ್ಯವಿರುವ ರಸ್ತೆ ಗುಂಡಿಯ ಬಗ್ಗೆ ದೂರು ಸಲ್ಲಿಸುತ್ತಿದ್ದೇನೆ.

${locLines}
ಅಂದಾಜು ಗಾತ್ರ: ${size}
ವಿವರ: ${a.description}

ಗುಂಡಿಯ ಛಾಯಾಚಿತ್ರವನ್ನು ಈ ಇಮೇಲ್‌ಗೆ ಲಗತ್ತಿಸಲಾಗಿದೆ. ಈ ಗುಂಡಿ ದ್ವಿಚಕ್ರ ವಾಹನ ಸವಾರರಿಗೆ ಮತ್ತು ಇತರ ರಸ್ತೆ ಬಳಕೆದಾರರಿಗೆ ಅಪಾಯಕಾರಿ. ಇದನ್ನು ಶೀಘ್ರ ಪರಿಶೀಲಿಸಿ ದುರಸ್ತಿ ಮಾಡಬೇಕೆಂದು, ಮತ್ತು ಈ ರಸ್ತೆ ನಿರ್ವಹಣಾ ವಾರಂಟಿ ಅಡಿಯಲ್ಲಿದ್ದರೆ ಸಂಬಂಧಿತ ಗುತ್ತಿಗೆದಾರರಿಂದ ದುರಸ್ತಿ ಮಾಡಿಸಬೇಕೆಂದು ವಿನಂತಿಸುತ್ತೇನೆ. ಈ ದೂರನ್ನು ಸಹಾಯ (Sahaaya) ವೇದಿಕೆಯಲ್ಲಿಯೂ ದಾಖಲಿಸುತ್ತೇನೆ.

ನಗರ ಸೇವೆಗೆ ಧನ್ಯವಾದಗಳು.

ವಂದನೆಗಳು,
${S.name}`
      : `Dear ${officerName || "Sir or Madam"},

I would like to report a pothole that needs urgent repair.

${locLines}
Approximate size: ${size}
Details: ${a.description}

A photograph of the pothole is attached to this email. This pothole poses a danger to two wheeler riders and other road users. I request the city corporation to inspect and repair it at the earliest, and to route it to the contractor responsible if this road section is still under a maintenance warranty. I am also filing this grievance on Sahaaya so it can be tracked to resolution.

Thank you for your service to the city.

Regards,
${S.name}`;
    if (tender) {
      const warrantyKn = ({ dlp: "ದೋಷ ಹೊಣೆಗಾರಿಕೆ ಅವಧಿಯಲ್ಲಿ ಇನ್ನೂ ಇರುವ ಸಾಧ್ಯತೆ ಹೆಚ್ಚು", maint: "ನಿರ್ವಹಣಾ ಅವಧಿಯಲ್ಲಿ ಇನ್ನೂ ಇರುವ ಸಾಧ್ಯತೆ ಇದೆ", record: "ಈ ಭಾಗದ ದಾಖಲೆಯಲ್ಲಿದೆ" })[tender.warranty_code || "record"];
      const para = kn
        ? `ಸಾರ್ವಜನಿಕ ಖರೀದಿ ದಾಖಲೆಗಳ ಪ್ರಕಾರ ಈ ರಸ್ತೆ ಭಾಗ ಟೆಂಡರ್ ${tender.tender_number} ("${tender.title.slice(0, 140).trim()}") ಅಡಿಯಲ್ಲಿ ಬರುವ ಸಾಧ್ಯತೆ ಇದೆ. ಇದನ್ನು ${tender.published} ರಂದು ${tender.contractor} ಅವರಿಗೆ ನೀಡಲಾಗಿದ್ದು, ${warrantyKn}. ದೋಷ ಹೊಣೆಗಾರಿಕೆ ಅಥವಾ ನಿರ್ವಹಣಾ ಅವಧಿ ಜಾರಿಯಲ್ಲಿದ್ದರೆ, ಪಾಲಿಕೆಗೆ ಹೆಚ್ಚುವರಿ ವೆಚ್ಚವಿಲ್ಲದೆ ಗುತ್ತಿಗೆದಾರರಿಂದಲೇ ದುರಸ್ತಿ ಮಾಡಿಸಬೇಕೆಂದು ವಿನಂತಿಸುತ್ತೇನೆ. ಇದು ಸಂಭಾವ್ಯ ದಾಖಲೆ ಹೊಂದಾಣಿಕೆ; ದಯವಿಟ್ಟು ಟೆಂಡರ್ ದಾಖಲೆಗಳೊಂದಿಗೆ ಪರಿಶೀಲಿಸಿ.`
        : `Public procurement records indicate this road stretch probably falls under tender ${tender.tender_number} ("${tender.title.slice(0, 140).trim()}"), awarded on ${tender.published} to ${tender.contractor}, and is ${tender.warranty}. If the defect liability or maintenance period is in force, I request that the repair be carried out by the contractor at no additional cost to the corporation. This is a probable record match; kindly verify against the tender documents.`;
      body = kn
        ? body.replace("\n\nನಗರ ಸೇವೆಗೆ", `\n\n${para}\n\nನಗರ ಸೇವೆಗೆ`)
        : body.replace("\n\nThank you", `\n\n${para}\n\nThank you`);
    }
    return [subject, body];
  }

  // ---------- storage (IndexedDB) ----------
  let _db = null;
  function idb() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open("potholes", 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("reports")) d.createObjectStore("reports", { keyPath: "id", autoIncrement: true });
        // How many frames a drive actually checked is only known while it runs:
        // rejected frames are not kept unless debug mode is on, so the count has to
        // be recorded at the end or it is lost.
        if (!d.objectStoreNames.contains("drives")) d.createObjectStore("drives", { keyPath: "id" });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }
  function op(mode, fn, storeName = "reports") {
    return idb().then((d) => new Promise((resolve, reject) => {
      const store = d.transaction(storeName, mode).objectStore(storeName);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }
  const allReports = () => op("readonly", (s) => s.getAll());
  const getReport = (id) => op("readonly", (s) => s.get(Number(id)));
  const putReport = (r) => op("readwrite", (s) => s.put(r));
  const addReport = (r) => op("readwrite", (s) => s.add(r));
  const delReport = (id) => op("readwrite", (s) => s.delete(Number(id)));
  const allDrives = () => op("readonly", (s) => s.getAll(), "drives");
  const putDrive = (d) => op("readwrite", (s) => s.put(d), "drives");

  const toDict = (r) => ({ ...r, photo_url: r.photo });

  // ---------- image ----------
  // Between 7 PM and 5 AM a dark frame is lifted so the model can read the road.
  // This is a detection aid only: it never touches the copy attached to a complaint,
  // which must be what the camera saw and not something visibly processed.
  const isNight = () => { const h = new Date().getHours(); return h >= 19 || h < 5; };

  async function toDataUrl(blob, maxDim, quality = 0.85, boost = false) {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    if (boost && isNight()) {
      ctx.filter = "brightness(1.6) contrast(1.15)";
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      ctx.filter = "none";
    }
    return c.toDataURL("image/jpeg", quality);
  }

  // ---------- pipeline ----------
  async function createReport(fd, driveMode) {
    const photo = fd.get("photo");
    if (!photo || !photo.size) throw new Error("Empty photo.");
    const latRaw = fd.get("lat"), lngRaw = fd.get("lng");
    const lat = latRaw != null && latRaw !== "" ? parseFloat(latRaw) : null;
    const lng = lngRaw != null && lngRaw !== "" ? parseFloat(lngRaw) : null;
    const driveId = driveMode ? (fd.get("drive_id") || null) : null;

    if (driveMode && lat != null) {
      const cutoff = Date.now() / 1000 - DEDUPE_WINDOW_S;
      for (const r of await allReports()) {
        if ((r.status === "draft" || r.status === "queued" || r.status === "sent" || r.status === "unrouted") && r.lat != null &&
            r.created_at > cutoff && distMeters(lat, lng, r.lat, r.lng) < DEDUPE_RADIUS_M) {
          return { found: false, skipped: "already reported nearby" };
        }
      }
    }

    progress(driveMode ? pmsg("capture") : pmsg("compress"));
    // Drive Mode ran at 1280 until an eval showed it drops real potholes that survive
    // at full size: distant, small defects lose just enough detail to fall under the
    // confidence gate. Resolution is the one thing detection cannot get back.
    const dataUrl = await toDataUrl(photo, 2000, 0.85, true);
    // Geocoding runs in parallel with the AI calls; it never gates detection.
    const geoP = lat != null ? reverseGeocode(lat, lng).catch(() => null) : Promise.resolve(null);
    progress(pmsg("detect"));
    // Single shot: contract adjudication runs speculatively alongside confirmation,
    // so the wait is the max of the two rather than their sum, and one watching user
    // feels it. Drive Mode rejects most frames and reports through the HUD, so
    // speculating there would buy nothing and bill a text call per frame.
    // Coordinates settle coverage on their own; only a missing fix has to wait for the
    // address. Speculating on contracts outside Bengaluru would match a road name in
    // the wrong city, so it is not started at all.
    const coordCoverage = (lat != null && lng != null) ? inCoverage(lat, lng, null) : null;
    const tenderP = (driveMode || coordCoverage === false) ? null
      : geoP.then((addr) => (inCoverage(lat, lng, addr) ? matchTender(addr) : null)).catch(() => null);
    const detectPrompt = DETECT_PROMPT + (LANG() === "kn"
      ? "\n- Write the description field in formal Kannada (ಕನ್ನಡ ಭಾಷೆಯಲ್ಲಿ ಬರೆಯಿರಿ)."
      : "");
    // Single shot has one verdict on screen, so show it the moment it streams in.
    // Drive Mode analyses run concurrently and report through the HUD instead.
    const a = await analyzeImage(dataUrl, detectPrompt, "assessment", ASSESS_SCHEMA, MODEL,
      driveMode ? null : emitVerdict);
    const accepted = a.is_pothole && a.confidence >= MIN_CONFIDENCE;
    if (driveMode && !accepted) {
      if (S.debug) await saveDebugFrame(dataUrl, lat, lng, `Debug frame: analyzed, no pothole confirmed (${Math.round(a.confidence * 100)}%). ${a.description}`, a.confidence, driveId);
      return { found: false };
    }

    if (accepted) progress(pmsg("finalize"));
    const address = accepted ? await geoP : null;
    const covered = accepted && (coordCoverage !== null ? coordCoverage : inCoverage(lat, lng, address));
    const [officerName, officerEmail] = accepted ? routeOfficer(address, covered) : [null, null];
    const tender = accepted && covered
      ? await (tenderP || matchTender(address).catch(() => null))
      : null;
    if (accepted) progress(pmsg("write"));
    // No authority means no complaint. The photo, verdict and location are still kept,
    // so nothing is lost if coverage later extends to this place.
    const [subject, body] = accepted && covered
      ? draftEmail(a, lat, lng, address, officerName, tender)
      : [null, null];
    // The evidence copy: what the officer receives. Detection works on a small
    // frame for speed and token cost, but the complaint deserves the full capture,
    // unmodified. Only kept for reports that can actually be emailed.
    const photoFull = accepted && covered ? await toDataUrl(photo, 4000, 0.92, false) : null;

    const rec = {
      created_at: Date.now() / 1000, lat, lng, address, photo: dataUrl, photo_full: photoFull,
      is_pothole: a.is_pothole ? 1 : 0, size: a.size, confidence: a.confidence,
      description: a.description, email_subject: subject, email_body: body,
      status: accepted ? (covered ? "draft" : "unrouted") : "rejected",
      officer_name: officerName, officer_email: officerEmail,
      tender_number: tender ? tender.tender_number : null,
      contractor: tender ? tender.contractor : null,
      tender_note: tender ? tender.note : null,
      sent_at: null,
      drive_id: driveId,
    };
    rec.id = await addReport(rec);
    return driveMode ? { found: true, report: toDict(rec) } : toDict(rec);
  }

  async function saveDebugFrame(dataUrl, lat, lng, description, confidence = 0, driveId = null) {
    const rec = {
      created_at: Date.now() / 1000, lat, lng, address: null, photo: dataUrl,
      is_pothole: 0, size: null, confidence, description,
      email_subject: null, email_body: null, status: "rejected",
      officer_name: null, officer_email: null,
      tender_number: null, contractor: null, tender_note: null, sent_at: null,
      drive_id: driveId,
    };
    rec.id = await addReport(rec);
  }

  async function openInGmail(rec) {
    // Always the routed officer. The app never sends; the user does, in their email app.
    // No fallback recipient: an unrouted report must not borrow Bengaluru's address.
    if (!rec.officer_email) {
      throw new Error("No responsible authority is known for this location, so there is nobody to address.");
    }
    const to = rec.officer_email;
    progress(pmsg("email"));
    if (NATIVE) {
      // Vanilla-JS WebView: the injected runtime exposes plugins via Capacitor.Plugins
      // and has no registerPlugin. Support both for bundler compatibility.
      const EmailComposer = Capacitor.registerPlugin
        ? Capacitor.registerPlugin("EmailComposer")
        : Capacitor.Plugins.EmailComposer;
      await EmailComposer.open({
        to: [to],
        subject: rec.email_subject || "",
        body: rec.email_body || "",
        // Full capture where we kept one; the working copy is only a fallback.
        attachments: [{ type: "base64", name: "pothole.jpg",
                        path: (rec.photo_full || rec.photo).split(",")[1] }],
      });
    } else {
      console.log("[harness] would open native compose to:", to);
    }
    rec.status = "queued";
    rec.sent_at = Date.now() / 1000;
    await putReport(rec);
    return toDict(rec);
  }

  // ---------- dataset export ----------
  // A stored-entry ZIP, written by hand: JPEGs are already compressed, so there is
  // nothing to gain from deflate and no reason to pull in a zip library.
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return (buf) => {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
  })();

  function zip(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    const u16 = (n) => [n & 255, (n >> 8) & 255];
    const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = CRC(f.data);
      const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length),
        ...u16(name.length), ...u16(0)]);
      chunks.push(local, name, f.data);
      central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0),
        ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length),
        ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
        ...u32(offset)]), name);
      offset += local.length + name.length + f.data.length;
    }
    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0),
      ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
    const all = [...chunks, ...central, end];
    const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of all) { out.set(c, at); at += c.length; }
    return out;
  }

  const b64ToBytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const bytesToB64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };

  // Exports only what a human actually labelled: a model verdict is not ground truth,
  // and a benchmark built from the detector's own opinions cannot measure the detector.
  async function exportDataset() {
    const labelled = (await allReports()).filter((r) => r.human_label);
    if (!labelled.length) throw new Error("Nothing labelled yet. Open Review frames and tag some first.");
    const files = [], index = [];
    for (const r of labelled) {
      const name = `images/frame-${r.id}.jpg`;
      files.push({ name, data: b64ToBytes(r.photo.split(",")[1]) });
      index.push({
        path: name,
        label: r.human_label,
        labelled_by: "owner",
        model_said: { is_pothole: !!r.is_pothole, size: r.size, confidence: r.confidence,
                      description: r.description },
        lat: r.lat, lng: r.lng, address: r.address,
        drive_id: r.drive_id, captured_at: new Date(r.created_at * 1000).toISOString(),
      });
    }
    files.push({ name: "labels.json", data: new TextEncoder().encode(
      JSON.stringify({ exported_at: new Date().toISOString(), count: index.length, images: index }, null, 1)) });
    const bytes = zip(files);
    return { name: `pothole-dataset-${Date.now()}.zip`, base64: bytesToB64(bytes),
             count: index.length, bytes: bytes.length };
  }

  // ---------- API dispatch ----------
  async function handle(path, opts) {
    const method = ((opts && opts.method) || "GET").toUpperCase();
    let m;
    if (path === "/api/health") {
      return { ai_configured: !!S.key, provider: "openai", delivery: "gmail_compose", email_configured: true };
    }
    if (path === "/api/reports" && method === "GET") {
      return (await allReports()).sort((a, b) => b.id - a.id).map(toDict);
    }
    if (path === "/api/reports" && method === "DELETE") {
      await op("readwrite", (s) => s.clear());
      await op("readwrite", (s) => s.clear(), "drives");
      return { ok: true };
    }
    if (path === "/api/drives" && method === "GET") return allDrives();
    if (path === "/api/drives" && method === "POST") {
      const d = JSON.parse(opts.body);
      if (!d || !d.id) throw new Error("Drive id missing.");
      await putDrive({ id: String(d.id), started_at: d.started_at || null,
                       ended_at: Date.now() / 1000, checked: d.checked | 0, found: d.found | 0 });
      return { ok: true };
    }
    if (path === "/api/export" && method === "POST") return exportDataset();
    if ((m = path.match(/^\/api\/reports\/(\d+)\/label$/)) && method === "POST") {
      const rec = await getReport(m[1]);
      if (!rec) throw new Error("Report not found.");
      const want = JSON.parse(opts.body).label;
      if (!["pothole", "not_pothole", null].includes(want)) throw new Error("Bad label.");
      rec.human_label = want;
      await putReport(rec);
      return toDict(rec);
    }
    if (path === "/api/report" && method === "POST") return createReport(opts.body, false);
    if (path === "/api/frame" && method === "POST") return createReport(opts.body, true);
    if ((m = path.match(/^\/api\/reports\/(\d+)\/send$/)) && method === "POST") {
      const rec = await getReport(m[1]);
      if (!rec) throw new Error("Report not found.");
      if (rec.status === "unrouted") {
        throw new Error("This pothole is outside the area this app covers, so there is no authority to address.");
      }
      // "queued" stays reopenable: canceling the Gmail composer must not strand the report.
      if (rec.status !== "draft" && rec.status !== "queued") throw new Error("This report is not a sendable draft.");
      return openInGmail(rec);
    }
    if ((m = path.match(/^\/api\/reports\/(\d+)$/))) {
      const rec = await getReport(m[1]);
      if (!rec) throw new Error("Report not found.");
      if (method === "PATCH") {
        if (rec.status !== "draft" && rec.status !== "queued") throw new Error("Only drafts can be edited.");
        const upd = JSON.parse(opts.body);
        rec.email_subject = upd.email_subject;
        rec.email_body = upd.email_body;
        await putReport(rec);
        return toDict(rec);
      }
      if (method === "DELETE") {
        if (rec.status === "sent") throw new Error("Sent reports cannot be discarded.");
        await delReport(rec.id);
        return { ok: true };
      }
    }
    throw new Error(`Unhandled: ${method} ${path}`);
  }

  // Native hardware back button routes through window.handleAppBack (defined by the UI).
  if (NATIVE) {
    try {
      const App = Capacitor.Plugins.App;
      if (App && App.addListener) {
        App.addListener("backButton", () => {
          if (!(window.handleAppBack && window.handleAppBack())) App.exitApp();
        });
      }
    } catch (e) {}
  }

  window.StandaloneAPI = { handle, prewarm };

  // First run: open settings if no key yet (after the main script wires the UI).
  window.addEventListener("load", () => {
    if (!S.key && typeof window.openSettings === "function") window.openSettings(true);
  });
})();
