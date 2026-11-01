/* What LLM can you choose? Vanilla JS, no build step, no network except this server. */
(function () {
  "use strict";

  var GIB = Math.pow(2, 30);
  var $ = function (id) { return document.getElementById(id); };
  var state = {
    q: { profile: "general", context: 4096, top: 10, fit: "any", gpu: "" },
    data: null,
    token: 0,
    pollTimer: null,
    clockTimer: null,
    started: 0
  };

  /* ---------- small helpers ---------- */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function gb(bytes) {
    var v = bytes / GIB;
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  }
  function n1(v) { return Number(v).toFixed(1); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function ctxLabel(c) { return c >= 1024 ? (c / 1024) + "K" : String(c); }
  function compact(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
    return String(n);
  }
  function splitId(id) {
    var i = id.indexOf("/");
    return i < 0 ? { org: "", name: id } : { org: id.slice(0, i), name: id.slice(i + 1) };
  }
  function ago(sec) {
    if (sec < 20) return "Scanned just now";
    if (sec < 90) return "Scanned a minute ago";
    return "Scanned " + Math.round(sec / 60) + " min ago";
  }

  /* ---------- plain-words dictionaries ---------- */
  var FIT = {
    full_gpu: { label: "Fits, runs fast", cls: "ok", say: "The whole model sits in fast memory. This is the best case." },
    partial_offload: { label: "Too big, runs slower", cls: "part", say: "The model is too big for the fast memory. The rest waits in slower memory. It works, but slower." },
    cpu_only: { label: "Processor only, slow", cls: "cpu", say: "Only the main processor runs it. Expect it to be slow." }
  };
  var EVIDENCE = {
    direct: "Tested directly. Outside benchmarks measured this exact model, so its score is a real result.",
    estimated: "Estimated. No benchmark for this exact model, so the score is worked out from a close relative. Treat it as a good guess.",
    self_reported: "Self reported. The scores come from the maker, not from an outside test. Treat them with some care.",
    none: "No benchmark found. The score is a weak guess from the model size. Do not lean on it."
  };
  var BENCH_SHORT = { direct: "tested", estimated: "best guess", self_reported: "maker's claim", none: "no test found" };
  var CONF = { high: "solid", medium: "fair", low: "rough" };

  function speedFeel(tps) {
    var words = tps * 0.75;
    if (tps < 2) return "About " + n1(words) + " words a second. That is slower than most people read.";
    if (tps < 5) return "About " + n1(words) + " words a second. That is close to reading speed.";
    if (tps < 20) return "About " + n1(words) + " words a second. That is faster than you can read.";
    return "About " + Math.round(words) + " words a second. Replies feel instant.";
  }
  function plainNote(n) {
    if (/synthetic GGUF/i.test(n)) return "No ready-made file was measured. The size is worked out from the model's parameters.";
    if (/Apple Silicon MoE/i.test(n)) return "On Apple chips, this kind of model changes a lot with the app you use (the app you use to run it).";
    if (/MoE speed/i.test(n)) return "This is a mixture-of-experts model. Only part of it works on each word, so it can run faster than its size suggests.";
    if (/estimated from memory bandwidth/i.test(n)) return "Speed is a calculation, not a stopwatch run. It uses how fast the memory is, the file size and how well the model fits.";
    return n;
  }
  function plainBudget(n) {
    var m = /headroom: ([\d.]+) GB reserved per GPU/i.exec(n);
    return m ? m[1] + " GB kept back for the system" : n;
  }

  /* ---------- hardware plate ---------- */
  function hwSummary(hw) {
    var gpus = hw.gpus || [];
    var simulated = gpus.some(function (g) { return /simulated/i.test(g.name); });
    if (!gpus.length) {
      return { chip: hw.cpu || "CPU only", kind: "No GPU found. Models run from system RAM.", mem: hw.ram_bytes, bw: null,
               usable: hw.ram_budget_bytes || hw.ram_bytes, simulated: false, hw: hw };
    }
    var mem = 0, usable = 0;
    gpus.forEach(function (g) { mem += g.vram_bytes; usable += g.usable_vram_bytes; });
    var g0 = gpus[0];
    var name = g0.name.replace(/\s*\(simulated\)/i, "");
    if (gpus.length > 1) name = gpus.length + " x " + name;
    return {
      chip: name,
      kind: g0.shared_memory ? "Unified memory. CPU and GPU share one pool." : "Dedicated graphics memory.",
      mem: mem, bw: g0.memory_bandwidth_gbps, usable: usable, simulated: simulated, hw: hw
    };
  }
  function renderPlate(hw) {
    var s = hwSummary(hw), body = $("plate-body");
    clear(body);
    body.appendChild(h("p", { class: "plate-chip", text: s.chip }));
    body.appendChild(h("p", { class: "plate-kind", text: s.kind }));
    if (s.simulated) body.appendChild(h("span", { class: "plate-sim", text: "What if. Not your chip." }));

    function stat(label, val, unit, hot) {
      return h("div", { class: "stat" + (hot ? " hot" : "") },
        h("dt", { text: label }),
        h("dd", { class: "num" }, val, h("small", { text: unit })));
    }
    body.appendChild(h("dl", { class: "plate-stats" },
      stat("Memory", gb(s.mem), "GB"),
      stat("Memory speed", s.bw ? Math.round(s.bw) : "n/a", s.bw ? "GB/s" : ""),
      stat("For AI", gb(s.usable), "GB", true)));

    var pct = Math.max(0, Math.min(100, (s.usable / s.mem) * 100));
    var bar = h("div", { class: "plate-bar" },
      h("div", { class: "track", role: "img", "aria-label": gb(s.usable) + " of " + gb(s.mem) + " GB for AI" },
        h("div", { class: "usable", style: "width:" + pct + "%" })),
      h("div", { class: "plate-bar-cap" },
        h("span", { text: gb(s.usable) + " GB for AI" }),
        h("span", { text: gb(s.mem - s.usable) + " GB held back" })));
    body.appendChild(bar);

    var foot = [];
    if (hw.cpu) foot.push(hw.cpu + ", " + hw.cpu_cores + " cores");
    if (hw.ram_bytes) foot.push(gb(hw.ram_bytes) + " GB system RAM");
    (hw.budget_notes || []).forEach(function (n) { foot.push(plainBudget(n)); });
    if (s.simulated) foot.push("CPU and RAM are still this machine's");
    body.appendChild(h("p", { class: "plate-foot", text: foot.join(". ") + "." }));
  }

  /* ---------- memory-fit bar ---------- */
  function memBar(m, opts) {
    var avail = m.vram_available_bytes || 1;
    var need = m.vram_required_bytes;
    var scale = Math.max(avail, need);
    var wPct = Math.min(100, (m.file_size_bytes / scale) * 100);
    var kPct = Math.max(0, ((need - m.file_size_bytes) / scale) * 100);
    var over = need > avail;
    var label = "Uses " + gb(need) + " GB of the " + gb(avail) + " GB for AI: " +
      gb(m.file_size_bytes) + " GB for the model file and " + gb(need - m.file_size_bytes) + " GB for your text" +
      (over ? ", it does not fit, so part waits in slower memory." : ".");
    var bar = h("div", { class: "mbar", role: "img", "aria-label": label });
    [25, 50, 75].forEach(function (t) { bar.appendChild(h("i", { class: "tick", style: "left:" + t + "%" })); });
    bar.appendChild(h("span", { class: "seg weights", style: "width:" + wPct + "%" }));
    bar.appendChild(h("span", { class: "seg work", style: "left:" + wPct + "%;width:" + kPct + "%" }));
    if (over) {
      var lim = (avail / scale) * 100;
      bar.appendChild(h("i", { class: "limit", style: "left:" + lim + "%" }));
    }
    return bar;
  }
  function fitFor(m) { return FIT[m.fit_type] || FIT.cpu_only; }

  /* ---------- ledger ---------- */
  function renderLedger() {
    var data = state.data, body = $("ledger-body");
    clear(body);
    var models = data.models || [];
    var hw = data.hardware;
    var avail = models.length ? models[0].vram_available_bytes : hwSummary(hw).usable;
    $("cols-scale").textContent = "of " + gb(avail) + " GB for AI";
    $("ledger-note").textContent = models.length
      ? models.length + " models for " + profileName(state.q.profile).toLowerCase() + ", reading " + ctxShort(state.q.context) + " at once. Best first."
      : "";
    if (!models.length) {
      body.appendChild(h("div", { class: "state" },
        h("img", { src: "assets/empty-state.svg", alt: "" }),
        h("div", null,
          h("h3", { text: "Nothing fits these settings." }),
          h("p", { text: "Try a shorter text length, turn off the fit filter, or pick a bigger computer under Try a different computer." }))));
      return;
    }
    var list = h("ol", { class: "rows" });
    models.forEach(function (m, i) { list.appendChild(row(m, i)); });
    body.appendChild(list);
    body.appendChild(h("div", { class: "legend", "aria-hidden": "true" },
      h("span", null, h("i", { class: "l-w" }), "The model file"),
      h("span", null, h("i", { class: "l-k" }), "Room for your text"),
      h("span", null, h("i", { class: "l-f" }), "Memory left free")));
  }

  function row(m, i) {
    var id = splitId(m.model_id), fit = fitFor(m);
    var lo = m.speed_range_tok_per_sec;
    var name = h("button", { type: "button", class: "r-name", "aria-label": "Why " + id.name + " ranks number " + m.rank,
      onclick: function (e) { openDrawer(m, i, false, e.currentTarget); } }, id.name);
    var li = h("li", { class: "row" + (i === 0 ? " top" : "") },
      h("div", { class: "r-rank num", "aria-hidden": "true", text: String(m.rank).padStart(2, "0") }),
      h("div", { class: "r-model" }, name,
        h("div", { class: "r-org" }, h("span", { text: id.org }), h("span", { class: "chip", text: m.quant_type, "aria-label": "File version " + m.quant_type }))),
      h("div", { class: "mfit" },
        h("div", { class: "m-label", text: "Memory it uses" }),
        memBar(m),
        h("div", { class: "mfit-cap" },
          h("span", null, h("strong", { text: gb(m.vram_required_bytes) }), h("span", { class: "of", text: " of " + gb(m.vram_available_bytes) + " GB" })),
          h("span", { class: "fit " + fit.cls, text: fit.label }))),
      h("div", { class: "r-size num" }, h("div", { class: "m-label", text: "Download size" }), gb(m.file_size_bytes), h("small", { text: "GB" })),
      h("div", { class: "r-speed" },
        h("div", { class: "m-label", text: "Speed" }),
        h("div", { class: "big num" }, n1(m.estimated_tok_per_sec), h("i", { text: "tokens/s" })),
        h("small", { text: lo ? n1(lo[0]) + " to " + n1(lo[1]) + ", " + (CONF[m.speed_confidence] || m.speed_confidence) : "" })),
      h("div", { class: "r-score num" },
        h("div", { class: "m-label", text: "Quality score" }), n1(m.quality_score),
        h("small", { text: (BENCH_SHORT[m.benchmark_status] || "no test found") })),
      h("div", { class: "r-act" },
        h("button", { type: "button", class: "btn", onclick: function (e) { openDrawer(m, i, false, e.currentTarget); } }, "Why"),
        h("button", { type: "button", class: "btn btn-run", "aria-label": "Run " + id.name,
          onclick: function (e) { openDrawer(m, i, true, e.currentTarget); } }, "Run")));
    return li;
  }

  /* ---------- drawer ---------- */
  var drawer, lastOpener;
  function commandsFor(m) {
    var ctx = state.q.context;
    var cmds = [];
    var run = "whichllm run " + m.model_id;
    if (m.quant_type && m.quant_type !== "unknown") run += " --quant " + m.quant_type;
    if (ctx !== 4096) run += " --context-length " + ctx;
    cmds.push({ name: "whichllm", text: run, note: "Downloads about " + gb(m.file_size_bytes) + " GB the first time. Needs the free tool uv installed first." });
    if (m.artifact_repo_id && m.quant_type) {
      var ref = m.artifact_repo_id + ":" + m.quant_type;
      cmds.push({ name: "Ollama", text: "ollama run hf.co/" + ref });
      cmds.push({ name: "llama.cpp", text: "llama-cli -hf " + ref + " -c " + ctx });
    }
    return cmds;
  }
  function copy(text, btn) {
    function ok() {
      var old = btn.textContent;
      btn.textContent = "Copied"; btn.classList.add("done");
      setTimeout(function () { btn.textContent = old; btn.classList.remove("done"); }, 1600);
    }
    function fallback() {
      var ta = h("textarea", { "aria-hidden": "true", style: "position:fixed;left:-999px" });
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); ok(); } catch (e) { btn.textContent = "Press Cmd+C"; }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }

  function infoBtn(hintId, label) {
    return h("button", { type: "button", class: "info", "data-hint": hintId, "aria-expanded": "false", "aria-controls": hintId, "aria-label": label }, "i");
  }
  function hintBox(id, text) { return h("p", { id: id, class: "hint", hidden: true }, text); }

  function sec(title, parts) {
    var s = h("section", { class: "dsec" }, h("h3", { text: title }));
    parts.forEach(function (p) { if (p) s.appendChild(p); });
    return s;
  }

  function openDrawer(m, idx, toRun, opener) {
    lastOpener = opener;
    state.pick = m.model_id;
    var id = splitId(m.model_id), fit = fitFor(m), body = $("drawer-body");
    clear(body);
    var models = state.data.models, above = idx > 0 ? models[idx - 1] : null;

    body.appendChild(h("div", { class: "drawer-head" },
      h("div", { class: "label", text: "Rank " + m.rank + " of " + models.length }),
      h("h2", { id: "drawer-title", text: id.name }),
      h("div", { class: "org", text: id.org + (m.parameter_count ? "  /  " + (m.parameter_count / 1e9).toFixed(1) + " billion parameters (its size)" : "") }),
      h("button", { type: "button", class: "x", "aria-label": "Close", onclick: function () { drawer.close(); } }, "×")));

    /* why */
    var lead;
    if (!above) lead = "This is the top pick. It has the highest quality score of the models that run on this setup.";
    else {
      var d = above.quality_score - m.quality_score;
      lead = d > 0.005
        ? "It sits below #" + above.rank + " because its quality score is " + d.toFixed(2) + " points lower."
        : "It scores the same as #" + above.rank + ", so other details decide the order.";
      if (m.estimated_tok_per_sec > above.estimated_tok_per_sec * 1.05)
        lead += " It is faster, though: " + n1(m.estimated_tok_per_sec) + " tokens a second against " + n1(above.estimated_tok_per_sec) + ".";
    }
    body.appendChild(sec("Why it ranks here", [
      h("p", { class: "why-lead", text: lead }),
      h("p", { text: "The list is sorted by quality first. Then it checks that the model fits your memory and runs at a usable speed." })
    ]));

    body.appendChild(sec("How good it is", [
      h("div", { class: "hero" }, h("span", { class: "n", text: n1(m.quality_score) }), h("span", { class: "u", text: "score, higher is better" })),
      h("p", { text: EVIDENCE[m.benchmark_status] || EVIDENCE.none }),
      m.benchmark_confidence != null ? h("dl", { class: "facts" },
        h("dt", null, "How sure we are", infoBtn("h-d-sure", "What How sure we are means")), h("dd", { text: Math.round(m.benchmark_confidence * 100) + " of 100" })) : null,
      m.benchmark_confidence != null ? hintBox("h-d-sure", "How much real test data backs this score. High means the exact model was tested. Low means the score is mostly a guess.") : null
    ]));

    var lo = m.speed_range_tok_per_sec;
    var spNotes = h("ul", { class: "notes" });
    (m.speed_notes || []).forEach(function (n) { spNotes.appendChild(h("li", { text: plainNote(n) })); });
    body.appendChild(sec("How fast it writes", [
      h("div", { class: "hero" }, h("span", { class: "n", text: n1(m.estimated_tok_per_sec) }), h("span", { class: "u" }, "tokens a second", infoBtn("h-d-speed", "What a token is"))),
      hintBox("h-d-speed", "AI writes in tokens, small pieces of words. One token is about three quarters of a word."),
      h("p", { text: speedFeel(m.estimated_tok_per_sec) }),
      lo ? h("p", { text: "Likely between " + n1(lo[0]) + " and " + n1(lo[1]) + " tokens a second. This guess is " + (CONF[m.speed_confidence] || m.speed_confidence) + "." }) : null,
      spNotes.childNodes.length ? spNotes : null
    ]));

    var work = m.vram_required_bytes - m.file_size_bytes;
    var free = m.vram_available_bytes - m.vram_required_bytes;
    var warns = h("ul", { class: "notes" });
    (m.warnings || []).forEach(function (w) { warns.appendChild(h("li", { text: w })); });
    body.appendChild(sec("Will it fit?", [
      h("p", { class: "why-lead", text: fit.say }),
      h("div", { style: "margin-top:16px" }, memBar(m)),
      h("dl", { class: "facts" },
        h("dt", null, "Model file (version " + m.quant_type + ")", infoBtn("h-d-quant", "What the file version means")), h("dd", { text: gb(m.file_size_bytes) + " GB" }),
        h("dt", { text: "Room for your text" }), h("dd", { text: gb(work) + " GB" }),
        h("dt", { text: "Total memory used" }), h("dd", { text: gb(m.vram_required_bytes) + " GB" }),
        h("dt", { text: "Free for AI here" }), h("dd", { text: gb(m.vram_available_bytes) + " GB" }),
        h("dt", { text: free >= 0 ? "Still free" : "Missing" }), h("dd", { text: gb(Math.abs(free)) + " GB" })),
      hintBox("h-d-quant", m.quant_type + " is the file version. A lower number means a smaller file with a little less quality."),
      h("p", { style: "margin-top:12px;font-size:15px;color:var(--ink-2)", text: "Room for your text holds what the model is reading (" + ctxShort(state.q.context) + " here) plus a little extra. More text needs more room." }),
      warns.childNodes.length ? warns : null
    ]));

    /* run */
    var cmds = commandsFor(m);
    var runSec = sec("Run it", [
      h("p", { text: "Nothing starts from this page. Copy a command and paste it into the Terminal app." })
    ]);
    runSec.id = "drawer-run";
    cmds.forEach(function (c) {
      var btn = h("button", { type: "button", class: "btn", "aria-label": "Copy the " + c.name + " command" }, "Copy");
      btn.addEventListener("click", function () { copy(c.text, btn); });
      runSec.appendChild(h("div", { class: "cmd" },
        h("div", { class: "cmd-top" }, h("span", { text: c.name }), btn),
        h("pre", null, h("code", { text: c.text })),
        c.note ? h("p", { style: "font-size:14px;color:var(--muted);margin-top:6px", text: c.note }) : null));
    });
    if (cmds.length === 1) runSec.appendChild(h("p", { style: "margin-top:14px;font-size:15px", text: "No ready-made file was found for Ollama or llama.cpp. The whichllm command searches for one when you start it." }));
    var useLink = h("a", { class: "drawer-link use-link", href: "#harness" }, "Use it with an app or a code editor");
    useLink.addEventListener("click", function (e) {
      e.preventDefault();
      drawer.close();
      scrollToHarness();
    });
    runSec.appendChild(h("p", { style: "margin-top:14px;font-size:15px" }, useLink));
    body.appendChild(runSec);

    /* facts */
    var facts = h("dl", { class: "facts" });
    function fact(k, v) { if (v) { facts.appendChild(h("dt", { text: k })); facts.appendChild(h("dd", { text: v })); } }
    fact("Downloads", m.downloads ? compact(m.downloads) : "");
    fact("Published", m.published_at ? m.published_at.slice(0, 10) : "");
    fact("License", m.license || "");
    var link = h("a", { class: "drawer-link", href: "https://huggingface.co/" + m.model_id, target: "_blank", rel: "noopener noreferrer" }, "Open the model page on Hugging Face");
    body.appendChild(sec("About", [facts, h("p", { style: "margin-top:14px" }, link)]));

    drawer.showModal();
    drawer.scrollTop = 0;
    if (toRun) {
      var target = $("drawer-run");
      var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      var first = target.querySelector("button");
      if (first) first.focus({ preventScroll: true });
    }
  }

  /* ---------- loading and data ---------- */
  function queryString(extra) {
    var q = state.q, p = new URLSearchParams();
    p.set("top", q.top); p.set("context", q.context); p.set("profile", q.profile);
    if (q.fit !== "any") p.set("fit", q.fit);
    if (q.gpu) p.set("gpu", q.gpu);
    if (extra) Object.keys(extra).forEach(function (k) { p.set(k, extra[k]); });
    return p.toString();
  }
  function setBusy(on) {
    $("ledger").setAttribute("aria-busy", on ? "true" : "false");
    $("ledger").classList.toggle("busy", on);
    $("rescan").disabled = on;
    var hl = $("ledger").querySelector(".hairline");
    if (!hl) { hl = h("div", { class: "hairline", "aria-hidden": "true" }); $("ledger-cols").parentNode.insertBefore(hl, $("ledger-cols")); }
  }
  function showLoading(first) {
    var body = $("ledger-body");
    if (state.data && !first) { body.classList.add("dim"); return; }
    clear(body);
    var clock = h("p", { class: "clock", role: "status", text: "Scanning, 0 s" });
    body.appendChild(h("div", { class: "state" },
      h("img", { src: "assets/empty-state.svg", alt: "" }),
      h("div", null,
        h("h3", { text: "Scanning this machine and reading the model list." }),
        h("p", { text: "The first scan can take up to a minute. Later loads are instant." }),
        clock)));
    state.started = Date.now();
    clearInterval(state.clockTimer);
    state.clockTimer = setInterval(function () {
      clock.textContent = "Scanning, " + Math.round((Date.now() - state.started) / 1000) + " s";
    }, 1000);
  }
  function showError(msg) {
    clearInterval(state.clockTimer);
    var body = $("ledger-body");
    body.classList.remove("dim");
    clear(body);
    body.appendChild(h("div", { class: "state" },
      h("img", { src: "assets/empty-state.svg", alt: "" }),
      h("div", null,
        h("h3", { text: "The scan did not finish." }),
        h("p", { text: msg || "Something went wrong." }),
        h("button", { type: "button", class: "btn", onclick: function () { load(true); } }, "Try again"))));
    setBusy(false);
  }

  function load(refresh, first) {
    var token = ++state.token;
    clearTimeout(state.pollTimer);
    setBusy(true);
    showLoading(!state.data || !!first);

    function poll() {
      var url = "/api/models?" + queryString(refresh ? { refresh: 1 } : null);
      refresh = false; /* only the first request asks for a rescan */
      fetch(url, { cache: "no-store" }).then(function (r) {
        return r.json().then(function (j) { return { status: r.status, body: j }; });
      }).then(function (res) {
        if (token !== state.token) return;
        if (res.status === 202) { state.pollTimer = setTimeout(poll, 900); return; }
        if (res.status !== 200 || res.body.status !== "ready") { showError(res.body && res.body.error); return; }
        clearInterval(state.clockTimer);
        state.data = res.body;
        $("ledger-body").classList.remove("dim");
        renderPlate(res.body.hardware);
        renderLedger();
        $("age").textContent = ago(res.body.age_seconds || 0);
        setBusy(false);
        renderHarness();
      }).catch(function (err) {
        if (window.console) console.error(err);
        if (token === state.token) showError("Could not reach the local server. Is whichllm ui still running?");
      });
    }
    poll();
  }

  /* ---------- controls ---------- */
  function fillSelect(sel, items, current) {
    clear(sel);
    items.forEach(function (it) {
      var o = h("option", { value: it.value, text: it.label });
      if (String(it.value) === String(current)) o.selected = true;
      sel.appendChild(o);
    });
  }
  var GPU_GROUPS = [
    { name: "Apple Mac", items: ["M4 Pro", "M3 Max", "M2 Ultra"] },
    { name: "Gaming PC (one graphics card)", items: ["RTX 3060", "RTX 4070", "RTX 3090", "RX 7900 XTX", "RTX 4090", "RTX 5090"] },
    { name: "Workstation or server", items: ["2x RTX 3090", "H100"] }
  ];
  var GPU_TEXT = {
    "M4 Pro": "Mac mini, M4 Pro, 24 GB",
    "M3 Max": "MacBook Pro, M3 Max, 36 GB",
    "M2 Ultra": "Mac Studio, M2 Ultra, 64 GB",
    "RTX 3060": "Budget PC, RTX 3060, 12 GB",
    "RTX 4070": "Mid-range PC, RTX 4070, 12 GB",
    "RTX 3090": "Older fast PC, RTX 3090, 24 GB",
    "RX 7900 XTX": "AMD PC, RX 7900 XTX, 24 GB",
    "RTX 4090": "Top gaming PC, RTX 4090, 24 GB",
    "RTX 5090": "Newest top PC, RTX 5090, 32 GB",
    "2x RTX 3090": "Home AI box, 2x RTX 3090, 48 GB",
    "H100": "Rented server, H100, 80 GB"
  };
  function fillGpuSelect(sel, gpus, current) {
    clear(sel);
    function opt(value, label) {
      var o = h("option", { value: value, text: label });
      if (String(value) === String(current)) o.selected = true;
      return o;
    }
    sel.appendChild(opt("", "This computer (what I found)"));
    var seen = {};
    GPU_GROUPS.forEach(function (grp) {
      var g = h("optgroup", { label: grp.name });
      grp.items.forEach(function (name) {
        if (gpus.indexOf(name) < 0) return;
        seen[name] = true;
        g.appendChild(opt(name, GPU_TEXT[name]));
      });
      if (g.childNodes.length) sel.appendChild(g);
    });
    var other = h("optgroup", { label: "Other" });
    gpus.forEach(function (name) { if (!seen[name]) other.appendChild(opt(name, GPU_TEXT[name] || name)); });
    if (other.childNodes.length) sel.appendChild(other);
  }
  var PROFILE_TEXT = {
    general: { name: "Everyday chat", say: "Ask questions, write emails, get ideas, summarize things. The best all-round models." },
    coding: { name: "Writing code", say: "Models that are best at writing and fixing computer programs." },
    vision: { name: "Looking at pictures", say: "Models that can look at a photo or a screenshot and tell you what is in it." },
    math: { name: "Maths and logic", say: "Models that are best at numbers, puzzles and step-by-step thinking." }
  };
  function profileName(p) { return (PROFILE_TEXT[p] && PROFILE_TEXT[p].name) || p; }
  function showProfileSay() {
    var t = PROFILE_TEXT[state.q.profile];
    $("profile-say").textContent = t ? t.say : "";
  }
  var CTX_TEXT = { 4096: "About 6 pages (default)", 8192: "About 12 pages", 16384: "About 25 pages", 32768: "About 50 pages", 65536: "About 100 pages", 131072: "A whole novel (about 200 pages)" };
  function ctxPlain(c) { return CTX_TEXT[c] || (ctxLabel(c) + " tokens"); }
  function ctxShort(c) { return CTX_TEXT[c] ? CTX_TEXT[c].replace(" (default)", "").toLowerCase() : ctxLabel(c) + " tokens"; }
  var infoBound = false;
  function wireInfo() {
    if (infoBound) return;
    infoBound = true;
    document.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".info") : null;
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      var box = $(b.getAttribute("data-hint"));
      if (!box) return;
      var open = box.hidden;
      box.hidden = !open;
      b.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
  function buildControls(opts) {
    var profiles = opts.profiles || ["general", "coding", "vision", "math"];
    var group = $("f-profile");
    clear(group);
    profiles.forEach(function (p) {
      var input = h("input", { type: "radio", name: "profile", value: p });
      if (p === state.q.profile) input.checked = true;
      input.addEventListener("change", function () { state.q.profile = p; showProfileSay(); load(false); });
      group.appendChild(h("label", null, input, h("span", { text: profileName(p) })));
    });
    showProfileSay();
    wireInfo();
    fillSelect($("f-context"), (opts.contexts || [4096, 8192, 32768, 131072]).map(function (c) {
      return { value: c, label: ctxPlain(c) };
    }), state.q.context);
    fillSelect($("f-top"), [5, 10, 20, 40].map(function (n) { return { value: n, label: n + " models" }; }), state.q.top);
    fillGpuSelect($("f-gpu"), opts.gpus || [], state.q.gpu);

    $("f-context").addEventListener("change", function (e) { state.q.context = parseInt(e.target.value, 10); load(false); });
    $("f-top").addEventListener("change", function (e) { state.q.top = parseInt(e.target.value, 10); load(false); });
    $("f-gpu").addEventListener("change", function (e) { state.q.gpu = e.target.value; load(false); });
    $("f-fit").addEventListener("change", function (e) { state.q.fit = e.target.checked ? "full-gpu" : "any"; load(false); });
  }

  /* ---------- use it with: runners and apps ---------- */
  var HS = { data: null, runner: "ollama", tab: "chat", open: null, failed: false };
  var TABS = [
    { id: "chat", label: "Chat with it", kinds: ["chat-app", "server-ui"] },
    { id: "editor", label: "In my code editor", kinds: ["editor-addon"] },
    { id: "terminal", label: "Write code from the terminal", kinds: ["terminal-agent"] },
    { id: "all", label: "All", kinds: null }
  ];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function niceDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    return m ? parseInt(m[3], 10) + " " + MONTHS[parseInt(m[2], 10) - 1] + " " + m[1] : (iso || "");
  }
  function scrollToHarness() {
    var t = $("harness");
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    t.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    t.focus({ preventScroll: true });
  }
  /* true = Apple chip, false = not Apple, null = not known yet */
  function isApple() {
    if (!state.data || !state.data.hardware) return null;
    var gpus = state.data.hardware.gpus || [];
    if (!gpus.length) return /apple/i.test(state.data.hardware.cpu || "") ? true : false;
    return gpus.some(function (g) { return /apple|\bM[1-9]\b/i.test(g.name); });
  }
  function needTokens(a) {
    return a.min_context_tokens || (a.needs_big_memory_window ? 64000 : 0);
  }
  function pagesFor(tokens) {
    var p = tokens / 655;
    return p >= 10 ? Math.round(p / 5) * 5 : Math.max(1, Math.round(p));
  }
  function kLabel(tokens) { return Math.round(tokens / 1000) + "k"; }
  function pickModel() {
    var ms = (state.data && state.data.models) || [];
    for (var i = 0; i < ms.length; i++) if (ms[i].model_id === state.pick) return ms[i];
    return ms[0] || null;
  }
  function codeBox(label, text, what) {
    var btn = h("button", { type: "button", class: "btn", "aria-label": "Copy " + what }, "Copy");
    btn.addEventListener("click", function () { copy(text, btn); });
    return h("div", { class: "cmd hcode" },
      h("div", { class: "cmd-top" }, h("span", { text: label }), btn),
      h("pre", null, h("code", { text: text })));
  }
  function runnerById(id) {
    var rs = HS.data.runners;
    for (var i = 0; i < rs.length; i++) if (rs[i].id === id) return rs[i];
    return rs[0];
  }

  /* the buttons are rebuilt on every click, so give keyboard focus back to the same one */
  function refocus(parent, id) {
    var el = document.querySelector(parent + ' [data-id="' + id + '"]');
    if (el) el.focus({ preventScroll: true });
  }
  function renderRunners() {
    var box = $("h-runners"), det = $("h-runner-detail");
    clear(box); clear(det);
    var apple = isApple();
    var list = HS.data.runners.filter(function (r) { return r.id !== "mlx" || apple !== false; });
    if (!list.some(function (r) { return r.id === HS.runner; })) HS.runner = "ollama";
    list.forEach(function (r) {
      var on = r.id === HS.runner;
      var b = h("button", { type: "button", class: "rcard" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false",
        "data-id": r.id,
        onclick: function () { HS.runner = r.id; HS.open = null; renderRunners(); renderApps(); refocus("#h-runners", r.id); } },
        h("span", { class: "rname", text: r.name }),
        h("span", { class: "rstate", text: on ? "Chosen" : "Choose" }));
      box.appendChild(b);
    });
    var r = runnerById(HS.runner);
    det.appendChild(h("h4", { class: "hsub", text: r.name }));
    det.appendChild(h("p", { text: r.plain }));
    if (r.id === "mlx" && apple === null) det.appendChild(h("p", { class: "note", text: "This one only works on Apple chips (M1 and newer). Skip it on other computers." }));
    det.appendChild(codeBox("Install", r.install, "the " + r.name + " install line"));
    det.appendChild(codeBox("How to start", r.how_to_start, "the " + r.name + " start steps"));
    var m = pickModel();
    if (m && (r.id === "ollama" || r.id === "llamacpp")) {
      var want = r.id === "ollama" ? "Ollama" : "llama.cpp";
      commandsFor(m).forEach(function (c) {
        if (c.name === want) det.appendChild(codeBox("Run " + splitId(m.model_id).name, c.text, "the " + want + " command for " + splitId(m.model_id).name));
      });
    }
    det.appendChild(codeBox("Address that apps use", r.default_url, "the " + r.name + " address"));
    det.appendChild(h("p", { class: "note", text: "Apps connect to this address. It only works while the runner is running." }));
    det.appendChild(h("p", { class: "note" }, h("a", { class: "drawer-link", href: r.source, target: "_blank", rel: "noopener noreferrer" }, "Source for " + r.name)));
  }

  function renderTabs() {
    var box = $("h-tabs");
    clear(box);
    TABS.forEach(function (t) {
      box.appendChild(h("button", { type: "button", class: "pill" + (t.id === HS.tab ? " on" : ""), "aria-pressed": t.id === HS.tab ? "true" : "false", "data-id": t.id,
        onclick: function () { HS.tab = t.id; HS.open = null; renderTabs(); renderApps(); refocus("#h-tabs", t.id); } }, t.label));
    });
  }

  function appCard(a) {
    var runner = runnerById(HS.runner);
    var works = a.works_with_runners.indexOf(HS.runner) >= 0;
    var open = HS.open === a.id;
    var need = needTokens(a);
    var chips = h("div", { class: "chips" });
    (a.platforms || []).forEach(function (p) { chips.appendChild(h("span", { class: "chip", text: p })); });
    if (a.license) chips.appendChild(h("span", { class: "chip", text: a.license }));
    var chipsFit = h("div", { class: "chips" },
      h("span", { class: "chip " + (works ? "yes" : "no"), text: works ? "Works with your runner" : "Not listed for " + runner.name }));
    if (a.needs_big_memory_window) chipsFit.appendChild(h("span", { class: "chip big", text: "Needs " + kLabel(need) + " memory" }));

    var card = h("article", { class: "app" + (open ? " open" : ""), id: "app-" + a.id });
    card.appendChild(h("h4", { class: "aname", text: a.name }));
    card.appendChild(h("p", { class: "aplain", text: a.plain }));
    card.appendChild(h("p", { class: "agood" }, h("strong", { text: "Good for: " }), a.good_for));
    card.appendChild(chipsFit);
    card.appendChild(chips);
    if (need && state.q.context < need) {
      card.appendChild(h("p", { class: "warnbox", role: "note",
        text: "This app needs about " + pagesFor(need) + " pages of text at once. Your list is set to " + ctxShort(state.q.context) + ". Pick a bigger size above." }));
    }
    var panelId = "panel-" + a.id;
    var btn = h("button", { type: "button", class: "btn btn-set", "aria-expanded": open ? "true" : "false", "aria-controls": panelId,
      onclick: function () { HS.open = HS.open === a.id ? null : a.id; renderApps(); var again = $("app-" + a.id); if (again) { var b2 = again.querySelector(".btn-set"); if (b2) b2.focus({ preventScroll: true }); } } },
      open ? "Hide setup" : "Set it up");
    card.appendChild(btn);
    var panel = h("div", { id: panelId, class: "apanel", hidden: !open });
    if (open) {
      panel.appendChild(codeBox("Install", a.install, "the " + a.name + " install line"));
      panel.appendChild(codeBox("Connect it", a.connect, "the " + a.name + " connect steps"));
      panel.appendChild(h("p", { class: "note" }, h("a", { class: "drawer-link", href: a.source, target: "_blank", rel: "noopener noreferrer" }, "Source for " + a.name)));
    }
    card.appendChild(panel);
    return card;
  }

  function renderApps() {
    var box = $("h-apps");
    clear(box);
    var tab = TABS.filter(function (t) { return t.id === HS.tab; })[0];
    var list = HS.data.harnesses.filter(function (a) { return !tab.kinds || tab.kinds.indexOf(a.kind) >= 0; });
    $("h-count").textContent = list.length + " apps. Easiest first.";
    list.forEach(function (a) { box.appendChild(appCard(a)); });
  }

  function buildHarness() {
    var body = $("harness-body");
    clear(body);
    body.appendChild(h("p", { class: "hlead" },
      "A model alone is just a file. A runner starts it on your computer. An app is where you chat or write code. Step 1: pick a runner. Step 2: pick an app.",
      infoBtn("h-h-words", "What runner and app mean")));
    body.appendChild(hintBox("h-h-words", "A runner is a small program that loads the model and answers questions. An app is the screen or tool where you type and read the answers."));
    body.appendChild(h("h3", { class: "hstep", text: "Step 1. Pick a runner" }));
    body.appendChild(h("div", { id: "h-runners", class: "rgrid" }));
    body.appendChild(h("div", { id: "h-runner-detail", class: "rdetail" }));
    body.appendChild(h("h3", { class: "hstep", text: "Step 2. Pick an app" }));
    body.appendChild(h("p", { class: "hrule" },
      "Some apps need a big memory window (how much text the AI can read at once). ",
      HS.data.context_rule.plain + " ",
      infoBtn("h-h-rule", "More about the memory window"),
      " ",
      h("a", { class: "drawer-link", href: HS.data.context_rule.source, target: "_blank", rel: "noopener noreferrer" }, "Source")));
    body.appendChild(hintBox("h-h-rule", "A token is a small piece of a word. 64k tokens is about 100 pages. A bigger window uses more memory, so choose a bigger size in the list settings above."));
    body.appendChild(h("div", { id: "h-tabs", class: "pills", role: "group", "aria-label": "Kind of app" }));
    body.appendChild(h("p", { id: "h-count", class: "note", "aria-live": "polite" }));
    body.appendChild(h("div", { id: "h-apps", class: "agrid" }));
    body.appendChild(h("p", { class: "hfoot",
      text: "Checked against each project's own docs on " + niceDate(HS.data.checked) + ". We read the docs but did not run every step on a real computer. Tools change fast, so open the Source link if a step fails." }));
  }

  function renderHarness() {
    if (!HS.data) return;
    if (!$("h-apps")) buildHarness();
    renderRunners(); renderTabs(); renderApps();
  }
  function loadHarness() {
    fetch("harnesses.json").then(function (r) {
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    }).then(function (j) { HS.data = j; renderHarness(); })
      .catch(function (err) {
        if (window.console) console.error(err);
        var b = $("harness-body");
        clear(b);
        b.appendChild(h("p", { class: "say", text: "The list of apps did not load. Reload the page to try again." }));
      });
  }

  function init() {
    loadHarness();
    drawer = $("drawer");
    drawer.addEventListener("click", function (e) { if (e.target === drawer) drawer.close(); });
    drawer.addEventListener("close", function () { if (lastOpener && document.contains(lastOpener)) lastOpener.focus(); });
    $("rescan").addEventListener("click", function () { load(true); });
    fetch("/api/options").then(function (r) { return r.json(); }).catch(function () { return {}; })
      .then(function (opts) { buildControls(opts); load(false, true); });
  }
  init();
})();
