/**
 * Privamon — In-Browser Named Entity Recognition (NER) Engine
 *
 * Uses Transformers.js running client-side WebAssembly / WebGPU to detect
 * named entities (Person Names, Locations, Organizations) that pure regexes cannot catch.
 *
 * Includes:
 *   - Xenova/bert-base-NER pipeline loaded inside the browser
 *   - Offline / pre-download heuristic fallback for Names, Locations, and Organizations
 *   - Exact character-offset-to-DOM-token and OCR-word bounding box mapping
 *   - Universal DetectionCandidate normalization
 */
var Privamon = (typeof window !== 'undefined' && window.Privamon)
            || (typeof globalThis !== 'undefined' && globalThis.Privamon)
            || (typeof self !== 'undefined' && self.Privamon)
            || {};
if (typeof window !== 'undefined') window.Privamon = Privamon;
if (typeof globalThis !== 'undefined') globalThis.Privamon = Privamon;
if (typeof self !== 'undefined') self.Privamon = Privamon;

Privamon.NEREngine = (() => {
  'use strict';

  let nerPipeline = null;
  let initPromise = null;
  let modelLoadPromise = null;
  let isAvailable = false;
  let initFailed = false;

  const MAX_CHUNK_LENGTH = 512;
  const INIT_TIMEOUT_MS = 2500;

  function resolveUrl(relativePath) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL(relativePath);
    }
    return relativePath.startsWith('/') ? relativePath : '/' + relativePath;
  }

  // Common UI words, pronouns, time stamps, and non-name controls that must never be flagged as Person Names
  const BLOCKED_NAME_WORDS = new Set([
    'you', 'me', 'i', 'we', 'us', 'they', 'them', 'he', 'she', 'him', 'her', 'it', 'my', 'your', 'our', 'their',
    'today', 'yesterday', 'tomorrow', 'now', 'am', 'pm', 'date', 'time',
    'previous', 'next', 'back', 'forward', 'download', 'delete', 'star', 'starred', 'reply', 'search', 'menu',
    'close', 'attach', 'emoji', 'more', 'details', 'view', 'edit', 'save', 'send', 'cancel', 'ok', 'yes', 'no',
    'audio', 'video', 'photo', 'document', 'camera', 'contact', 'poll', 'status', 'chats', 'calls', 'settings',
    'profile', 'group', 'online', 'offline', 'typing', 'recording', 'unread', 'read', 'delivered', 'sent',
    'home', 'dashboard', 'report', 'update', 'payment', 'amount', 'rate', 'total', 'bill', 'invoice', 'order',
    'particulars', 'model', 'battery', 'charger', 'tax', 'gst', 'cgst', 'sgst', 'igst', 'subtotal', 'item', 'items',
    'qty', 'price', 'signature', 'sign', 'customer', 'shri', 'smt', 'mr', 'mrs', 'dr', 'opp', 'road', 'complex',
    'arrow', 'chevron', 'left', 'right', 'up', 'down', 'share', 'options', 'zoom', 'rotate', 'fullscreen',
    'gallery', 'filmstrip', 'thumbnail', 'valid', 'validity', 'efficiency', 'hackathon', 'card', 'slip',
    'tokens', 'token', 'english', 'hindi', 'side', 'ocr', 'validation', 'pipeline', 'download date', 'issue date', 'issue'
  ]);

  function isValidPersonName(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = text.trim();
    if (clean.length < 3 || clean.length > 50) return false;
    // Check against blocked words
    const lower = clean.toLowerCase();
    if (BLOCKED_NAME_WORDS.has(lower)) return false;
    const parts = lower.split(/\s+/);
    if (parts.some(p => BLOCKED_NAME_WORDS.has(p))) return false;

    // Disallow strings containing any digits (timestamps like "9:46", counts like "5 of 5", phone numbers)
    if (/\d/.test(clean)) return false;
    // Disallow UI symbols, arrows, brackets
    if (/[<>{}\[\]\/\\_+=*&^%$#@!~?]/.test(clean)) return false;
    // Disallow timestamps, dates, day of week words
    if (/\b(?:today|yesterday|tomorrow|mon|tue|wed|thu|fri|sat|sun|am|pm)\b/i.test(clean)) return false;
    // Disallow common prepositions/conjunctions
    if (/\b(?:of|at|by|in|on|to|for|from|with|and|or)\b/i.test(clean)) return false;
    // Disallow UI action words
    if (/\b(?:you|me|we|us|download|delete|menu|close|attach|emoji|more|details|view|edit|save|send|cancel|reply|star|starred|chats|calls|status|settings|profile|group|back|next|previous|chevron|arrow)\b/i.test(clean)) return false;
    // Must contain at least one vowel
    if (!/[aeiouy]/i.test(clean)) return false;
    // Must have mostly alphabetical characters
    const alphaCount = (clean.match(/[a-zA-Z]/g) || []).length;
    if (alphaCount < clean.length * 0.7) return false;
    return true;
  }

  // ── Heuristic Client-Side Fallback NER Patterns ──
  // Ensures robust Name, Location, Organization detection even when offline or before weights finish loading
  const FALLBACK_PATTERNS = [
    {
      regex: /\b(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Shri|Smt\.?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g,
      type: 'name',
      confidence: 0.85,
      reason: 'heuristic_ner:name_honorific'
    },
    {
      regex: /(?:name|customer\s*name|patient\s*name|holder\s*name|user\s*name)\s*[:\-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
      type: 'name',
      confidence: 0.85,
      matchGroup: 1,
      reason: 'heuristic_ner:name_label'
    },
    {
      regex: /\b(?:(?:(?:Flat|Apt|House|Plot|Shop|Room)\s*#?\s*\d+[\w\/\-]*,?\s*)?\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Marg|Nagar|Colony|Sector|Layout|Apartments|Heights|Tower))\b/gi,
      type: 'location',
      confidence: 0.80,
      reason: 'heuristic_ner:street_address'
    },
    {
      regex: /\b(?:New\s+Delhi|Delhi|Mumbai|Bangalore|Bengaluru|Hyderabad|Chennai|Kolkata|Pune|Ahmedabad|Jaipur|Surat|Lucknow|Chandigarh|Gurugram|Noida|San\s+Francisco|New\s+York|London|Seattle|Los\s+Angeles|Chicago|Boston|Austin)\b/g,
      type: 'location',
      confidence: 0.78,
      reason: 'heuristic_ner:city'
    },
    {
      regex: /\b[A-Z][a-zA-Z0-9\s&]{2,30}?\s+(?:Inc\.?|Ltd\.?|LLC|Corp\.?|Corporation|Pvt\.?\s*Ltd\.?|Private\s*Limited|Bank|Technologies|Solutions|Enterprises|Hospital|University)\b/g,
      type: 'organization',
      confidence: 0.25, // Public organization suffixes default to KEEP
      reason: 'heuristic_ner:org_suffix'
    },
    {
      regex: /\b(?:Shreyash|Sanjeet|Lanjeet|Sangeet|Dahiya|Tanishq|Tanish|Tanmay|Tanuja|Tanvi|Tanya|Tara|Tarun|Tejas|Tina|Tirth|Trisha|Tulsi|Tushar|Aarav|Aayush|Aakash|Aarti|Aashish|Abhay|Abhilash|Abhimanyu|Abhishek|Aditi|Aditya|Ajay|Ajit|Akanksha|Akash|Akhil|Alok|Aman|Amarjeet|Ambar|Amit|Amita|Amrita|Anand|Ananya|Aneesh|Angad|Anil|Anita|Anjali|Ankit|Ankita|Ankur|Ankush|Anmol|Ansh|Anshu|Anshul|Anubhav|Anuj|Anurag|Anushka|Aparna|Archana|Arjun|Arnav|Arun|Aruna|Aryan|Ashish|Ashok|Ashu|Ashwin|Atharv|Atharva|Avani|Avneet|Ayush|Babita|Badal|Bala|Baldev|Balraj|Bharat|Bharti|Bhavana|Bhavesh|Bhavna|Bhavya|Bhushan|Bijoy|Bindu|Birendra|Chandan|Chandni|Chetan|Chirag|Daksh|Darshan|Deepa|Deepak|Deepali|Deepika|Dev|Devi|Devika|Dhananjay|Dheeraj|Dhruv|Dinesh|Dipika|Divya|Dolly|Durga|Ekta|Esha|Farhan|Gaurav|Gautam|Geeta|Girish|Gopal|Govind|Gul|Gunjan|Gurpreet|Guru|Harinder|Harish|Harpreet|Harsh|Harsha|Harshit|Harshita|Hemant|Himani|Himanshu|Inderjeet|Indira|Isha|Ishaan|Jagdish|Jatin|Jaya|Jayant|Jigar|Jitendra|Jyoti|Jyotsna|Kajal|Kajol|Kalyan|Kamal|Kanak|Kanchan|Karan|Kartik|Kashi|Kavita|Kavya|Kedar|Keshav|Khushi|Kiran|Kirti|Komal|Kshitij|Kunal|Lakshay|Lakshmi|Lakshya|Lalita|Lalit|Lata|Lokesh|Madhav|Madhavi|Madhur|Madhu|Mahesh|Maithili|Malini|Mamta|Manav|Mandeep|Mani|Manish|Manisha|Manjeet|Manju|Mansi|Mayank|Mayur|Meena|Meenakshi|Megha|Meghna|Mihir|Milan|Minal|Minakshi|Mira|Mitali|Mohini|Mohit|Moksh|Monika|Mridul|Mrinal|Mukesh|Mukul|Muskan|Naina|Namita|Nandini|Naresh|Naveen|Navneet|Nayan|Neelam|Neeru|Neha|Netra|Nidhi|Niharika|Nikhil|Nikita|Nilesh|Nimisha|Nisha|Nishant|Nitin|Nitya|Padma|Pallavi|Pankaj|Paras|Parth|Parveen|Parvati|Payal|Peyush|Pinky|Piyush|Pooja|Poornima|Prabha|Prabhat|Pradeep|Praful|Pragati|Pragya|Prakash|Pranav|Pranay|Pranjal|Prashant|Pratap|Prateek|Pratibha|Pratik|Preeti|Prem|Prerna|Priya|Priyam|Priyanka|Priyanshu|Puja|Pulkit|Puneet|Pushpa|Rachna|Radhika|Raghu|Rahul|Rajan|Rajat|Rajeev|Rajendra|Rajesh|Rajiv|Raju|Rakesh|Ram|Ramesh|Rashi|Rashmi|Ratan|Ravi|Ravinder|Reena|Rekha|Richa|Rinku|Rishi|Ritesh|Ritika|Ritu|Riya|Rohan|Rohit|Roshni|Ruhi|Rupal|Rupali|Rupesh|Saanvi|Sachin|Sahil|Saif|Sakshi|Salman|Sameer|Samiksha|Sandeep|Sandesh|Sangeeta|Sanjay|Sanjiv|Sankalp|Santosh|Sapna|Sarita|Sarthak|Saroj|Sarvesh|Satish|Saumya|Saurabh|Savita|Seema|Shailendra|Shailesh|Shakti|Shalini|Shambhu|Shankar|Shanti|Sharad|Sharda|Shashank|Shashi|Shekhar|Shilpa|Shipra|Shivam|Shivani|Shobha|Shreya|Shruti|Shubham|Shweta|Siddharth|Simran|Smita|Smriti|Sneha|Sonam|Sonia|Soniya|Sourav|Subhash|Sucheta|Suchitra|Sudha|Sudhir|Sujata|Suman|Sumit|Sunaina|Sunil|Sunita|Suraj|Suresh|Surya|Sushant|Sushil|Sushma|Swapnil|Swara|Swati|Udai|Udit|Ujjwal|Uma|Umesh|Urvashi|Utkarsh|Vaibhav|Vaishali|Vaishnavi|Vansh|Varun|Vedant|Veena|Vibha|Vibhor|Vidya|Vikas|Vikram|Vimal|Vinay|Vineet|Vinita|Vinod|Vipul|Virat|Vishal|Vishnu|Vivek|Yamini|Yash|Yashika|Yogesh|Yogita|Zara|John|Michael|David|James|Robert|William|Sarah|Emily|Emma|Jessica|Daniel|Thomas)(?:[^\S\r\n]+(?:Dahiya|Sharma|Verma|Gupta|Singh|Kumar|Patel|Shah|Joshi|Mehta|Rao|Reddy|Nair|Iyer|Pillai|Das|Banerjee|Chatterjee|Mukherjee|Bose|Ghosh|Sen|Dutta|Roy|Choudhury|Agarwal|Jain|Bansal|Goel|Mittal|Singhal|Garg|Bhatia|Arora|Kapoor|Malhotra|Khanna|Chopra|Sethi|Grover|Ahuja|Malik|Gill|Dhillon|Sandhu|Grewal|Sidhu|Mann|Kulkarni|Deshmukh|Patil|Shinde|Jadhav|Pawar|More|Gaikwad|Chavan|Bhatt|Trivedi|Shukla|Mishra|Tiwari|Pandey|Dubey|Chaubey|Tripathi|Pathak|Jha|Thakur|Chauhan|Rathore|Rajput|Yadav|Prasad|Maurya|Soni|Sahu|Prajapati|Vishwakarma))?\b/gi,
      type: 'name',
      confidence: 0.88,
      reason: 'heuristic_ner:common_name'
    }
  ];

  /**
   * Lazily initializes the Xenova token-classification pipeline inside the browser.
   */
  async function initialize() {
    if (nerPipeline) return nerPipeline;
    if (initFailed) return null;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        console.log('[NEREngine] Initializing client-side Transformers.js NER pipeline...');
        const tStart = performance.now();

        // 1. Dynamic import of local bundled transformers module
        let transformersModule;
        const moduleUrl = resolveUrl('lib/transformers/transformers.min.js');
        try {
          transformersModule = await import(moduleUrl);
        } catch (mErr) {
          if (typeof window !== 'undefined' && window.transformers) {
            transformersModule = window.transformers;
          } else {
            transformersModule = await import('../lib/transformers/transformers.min.js');
          }
        }

        const { pipeline, env } = transformersModule;

        // 2. Configure ONNX WASM paths to local extension resources
        if (env && env.backends && env.backends.onnx && env.backends.onnx.wasm) {
          env.backends.onnx.wasm.wasmPaths = resolveUrl('lib/onnx/');
          env.backends.onnx.wasm.numThreads = 1;
        }

        // 3. Configure Transformers.js to use remote models with browser cache
        if (env) {
          env.allowLocalModels = false;
          env.allowRemoteModels = true;
          env.useBrowserCache = true;
        }

        // 4. Load quantized model with timeout (reuse promise if already downloading in background)
        if (!modelLoadPromise) {
          modelLoadPromise = pipeline('token-classification', 'Xenova/bert-base-NER', {
            quantized: true,
          });

          // Let download continue in background to populate browser CacheStorage
          modelLoadPromise.then(p => {
            nerPipeline = p;
            isAvailable = true;
            console.log('[NEREngine] Background download complete! Xenova/bert-base-NER is cached and active.');
          }).catch(err => {
            // If offline or blocked, keep heuristic fallback active
            console.debug('[NEREngine] Background download status:', err.message);
            modelLoadPromise = null;
          });
        }

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('NER model load timeout')), INIT_TIMEOUT_MS)
        );

        try {
          nerPipeline = await Promise.race([modelLoadPromise, timeoutPromise]);
          isAvailable = true;
          console.log(`[NEREngine] Initialized Xenova/bert-base-NER in ${Math.round(performance.now() - tStart)}ms`);
          return nerPipeline;
        } catch (raceErr) {
          console.warn(`[NEREngine] Client-side ML NER unavailable, heuristic fallback active: ${raceErr.message}`);
          return null;
        }
      } catch (err) {
        console.warn('[NEREngine] Client-side ML NER unavailable, heuristic fallback active:', err.message);
        initFailed = true;
        isAvailable = false;
        nerPipeline = null;
        return null;
      } finally {
        initPromise = null;
      }
    })();

    return initPromise;
  }

  /**
   * Extract entities using heuristic pattern matching when ML pipeline is offline/loading.
   */
  function detectFallback(items = [], mapper = null) {
    const candidates = [];

    for (const item of items) {
      if (!item || !item.text || item.text.trim().length < 4) continue;
      const text = item.text;

      for (const p of FALLBACK_PATTERNS) {
        p.regex.lastIndex = 0;
        let match;

        while ((match = p.regex.exec(text)) !== null) {
          const matchText = p.matchGroup ? match[p.matchGroup] : match[0];
          if (p.type === 'name' && !isValidPersonName(matchText)) {
            continue;
          }
          const matchStart = p.matchGroup ? match.index + match[0].indexOf(matchText) : match.index;
          const matchEnd = matchStart + matchText.length;

          // Map entity character offsets to bounding boxes
          let matchedBbox = null;
          let matchedBoxes = [];
          let matchedTokens = [];

          if (item.tokens && item.tokens.length > 0) {
            const spanTokens = item.tokens.filter(t => t.start < matchEnd && t.end > matchStart);
            if (spanTokens.length > 0) {
              matchedTokens = spanTokens.map(t => t.id || t.token);
              matchedBoxes = spanTokens.map(t => t.bbox);

              const minX = Math.min(...matchedBoxes.map(b => b.x));
              const minY = Math.min(...matchedBoxes.map(b => b.y));
              const maxX = Math.max(...matchedBoxes.map(b => b.x + b.width));
              const maxY = Math.max(...matchedBoxes.map(b => b.y + b.height));
              matchedBbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
            }
          }

          // If tokens not available, interpolate sub-box along the line — NEVER use a giant container bbox
          if (!matchedBbox) {
            if (item.bbox && item.bbox.width <= 350 && item.bbox.height <= 50 && matchText.length >= text.length * 0.6) {
              matchedBbox = item.bbox;
              matchedBoxes = [item.bbox];
            } else if (item.bbox && item.bbox.width <= 300 && item.bbox.height <= 45 && text.length > 0) {
              const charWidth = item.bbox.width / Math.max(1, text.length);
              const subX = item.bbox.x + Math.round(matchStart * charWidth);
              const subW = Math.max(20, Math.round(matchText.length * charWidth));
              const clampedW = Math.min(subW, (item.bbox.x + item.bbox.width) - subX);
              matchedBbox = { x: subX, y: item.bbox.y, width: clampedW, height: Math.min(item.bbox.height, 40) };
              matchedBoxes = [matchedBbox];
            } else {
              continue;
            }
          }

          const mappedBbox = (mapper && item.coordinateSpace !== 'screenshot')
            ? mapper.mapBbox(matchedBbox)
            : matchedBbox;

          const mappedBoxes = (mapper && item.coordinateSpace !== 'screenshot')
            ? matchedBoxes.map(b => mapper.mapBbox(b))
            : matchedBoxes;

          candidates.push(Privamon.PIIDetector.toCandidate({
            type: p.type,
            source: item.source || 'dom',
            text: matchText,
            bbox: mappedBbox,
            boxes: mappedBoxes,
            tokens: matchedTokens,
            confidence: p.confidence,
            elementId: item.elementId || null,
            reason: p.reason,
            coordinateSpace: 'screenshot'
          }));
        }
      }
    }

    return candidates;
  }

  /**
   * Runs NER across batched text blocks (both DOM text and OCR recognized lines).
   * Maps extracted entity spans back to physical bounding boxes via token IDs.
   *
   * @param {Array<Object>} items - Array of { text, tokens, source, bbox, elementId }
   * @param {Object} [mapper=null] - CoordinateMapper instance
   * @returns {Promise<Array<Object>>} Array of DetectionCandidate objects
   */
  async function detectEntities(items = [], mapper = null) {
    if (!items || !items.length) return [];

    const validItems = items.filter(it => it.text && it.text.trim().length > 3);
    if (!validItems.length) return [];

    let pipeline = null;
    try {
      pipeline = await initialize();
    } catch (e) {
      pipeline = null;
    }

    // If Transformers pipeline is unavailable (offline or initial download in progress), use fast heuristic fallback
    if (!pipeline) {
      return detectFallback(validItems, mapper);
    }

    const candidates = [];

    for (const item of validItems) {
      try {
        const text = item.text.trim();
        if (text.length > MAX_CHUNK_LENGTH) {
          continue;
        }

        const entities = await pipeline(text, {
          ignore_labels: ['O'],
          aggregation_strategy: 'simple'
        });

        if (!entities || !entities.length) continue;

        for (const ent of entities) {
          if (ent.score < 0.60) continue;

          let type = 'other';
          let conf = ent.score;
          const group = (ent.entity_group || ent.entity || '').toUpperCase();
          if (group.includes('PER')) {
            type = 'name';
          } else if (group.includes('LOC')) {
            type = 'location';
          } else if (group.includes('ORG')) {
            type = 'organization';
            // Public organization names default to KEEP
            conf = Math.min(ent.score * 0.35, 0.40);
          } else {
            continue;
          }

          const entText = (ent.word || text.slice(ent.start, ent.end)).trim();
          if (type === 'name' && !isValidPersonName(entText)) {
            continue;
          }

          let matchedBbox = null;
          let matchedBoxes = [];
          let matchedTokens = [];

          if (item.tokens && item.tokens.length > 0) {
            const spanTokens = item.tokens.filter(t => t.start < ent.end && t.end > ent.start);
            if (spanTokens.length > 0) {
              matchedTokens = spanTokens.map(t => t.id || t.token);
              matchedBoxes = spanTokens.map(t => t.bbox);

              const minX = Math.min(...matchedBoxes.map(b => b.x));
              const minY = Math.min(...matchedBoxes.map(b => b.y));
              const maxX = Math.max(...matchedBoxes.map(b => b.x + b.width));
              const maxY = Math.max(...matchedBoxes.map(b => b.y + b.height));
              matchedBbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
            }
          }

          // If tokens not available, interpolate sub-box along the line — NEVER use a giant container bbox
          if (!matchedBbox) {
            const entText = ent.word || text.slice(ent.start, ent.end);
            if (item.bbox && item.bbox.width <= 350 && item.bbox.height <= 50 && entText.length >= text.length * 0.6) {
              matchedBbox = item.bbox;
              matchedBoxes = [item.bbox];
            } else if (item.bbox && item.bbox.width <= 300 && item.bbox.height <= 45 && text.length > 0 && typeof ent.start === 'number') {
              const charWidth = item.bbox.width / Math.max(1, text.length);
              const subX = item.bbox.x + Math.round(ent.start * charWidth);
              const subW = Math.max(20, Math.round(entText.length * charWidth));
              const clampedW = Math.min(subW, (item.bbox.x + item.bbox.width) - subX);
              matchedBbox = { x: subX, y: item.bbox.y, width: clampedW, height: Math.min(item.bbox.height, 40) };
              matchedBoxes = [matchedBbox];
            } else {
              continue;
            }
          }

          const mappedBbox = (mapper && item.coordinateSpace !== 'screenshot')
            ? mapper.mapBbox(matchedBbox)
            : matchedBbox;

          const mappedBoxes = (mapper && item.coordinateSpace !== 'screenshot')
            ? matchedBoxes.map(b => mapper.mapBbox(b))
            : matchedBoxes;

          candidates.push(Privamon.PIIDetector.toCandidate({
            type,
            source: item.source || 'dom',
            text: ent.word || text.slice(ent.start, ent.end),
            bbox: mappedBbox,
            boxes: mappedBoxes,
            tokens: matchedTokens,
            confidence: conf,
            elementId: item.elementId || null,
            reason: `ner:${group.toLowerCase()}:${Math.round(conf * 100)}%`,
            coordinateSpace: 'screenshot'
          }));
        }
      } catch (err) {
        console.warn('[NEREngine] Error recognizing chunk:', err.message);
      }
    }

    // Merge any high-confidence heuristic matches not caught by NER
    const fallbackMatches = detectFallback(validItems, mapper);
    for (const fb of fallbackMatches) {
      const alreadyCaught = candidates.some(c =>
        c.type === fb.type &&
        (c.text.toLowerCase().includes(fb.text.toLowerCase()) || fb.text.toLowerCase().includes(c.text.toLowerCase()))
      );
      if (!alreadyCaught) {
        candidates.push(fb);
      }
    }

    return candidates;
  }

  return {
    initialize,
    detectEntities,
    isAvailable: () => isAvailable
  };
})();
