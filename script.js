/* ==========================================================================
   harshithm.com
   Starfield, scroll reveals, scroll spy, detail overlays, custom cursor.
   No dependencies.
   ========================================================================== */

(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var finePointer = window.matchMedia("(pointer: fine)");

  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  function guard(fn) {
    try {
      fn();
    } catch (err) {
      if (window.console) console.error(err);
    }
  }

  /* ------------------------------------------------------------------ *
   * Starfield
   * ------------------------------------------------------------------ */

  guard(function () {
    var FIELD = 2000;
    var COLORS = ["#ffffff", "#ffe9bb"];
    var layers = [
      { id: "stars1", count: 760 },
      { id: "stars2", count: 210 },
      { id: "stars3", count: 90 }
    ];

    function build(count) {
      var parts = [];
      for (var i = 0; i < count; i++) {
        var x = Math.floor(Math.random() * FIELD);
        var y = Math.floor(Math.random() * FIELD);
        parts.push(x + "px " + y + "px " + COLORS[Math.random() < 0.74 ? 0 : 1]);
      }
      return parts.join(",");
    }

    for (var i = 0; i < layers.length; i++) {
      var el = document.getElementById(layers[i].id);
      if (el) el.style.setProperty("--stars", build(layers[i].count));
    }
  });

  /* ------------------------------------------------------------------ *
   * Scroll reveals. Once only, staggered inside each batch.
   * ------------------------------------------------------------------ */

  guard(function () {
    window.__revealReady = true;
    var targets = document.querySelectorAll(".reveal");
    if (reduce.matches || !("IntersectionObserver" in window)) {
      each(targets, function (el) { el.classList.add("is-in"); });
      return;
    }

    /* Everything that arrives inside the same 140 ms window is one batch and
       gets the 70 ms cascade. A row that arrives on its own starts at zero. */
    var last = -1000;
    var index = 0;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var now = window.performance ? window.performance.now() : Date.now();
        if (now - last > 140) index = 0;
        last = now;
        entry.target.style.animationDelay = Math.min(index, 5) * 70 + "ms";
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
        index++;
      });
    }, { rootMargin: "0px 0px -10% 0px", threshold: 0.04 });

    each(targets, function (el) { io.observe(el); });
  });

  /* ------------------------------------------------------------------ *
   * Scroll spy. One dot travels under the active nav icon.
   * ------------------------------------------------------------------ */

  guard(function () {
    var nav = document.querySelector(".nav");
    var dot = document.querySelector(".nav-dot");
    if (!nav || !dot) return;

    var items = [];
    each(nav.querySelectorAll("a[href^='#']"), function (link) {
      var id = link.getAttribute("href").slice(1);
      var section = id === "top" ? document.querySelector(".hero") : document.getElementById(id);
      if (section) items.push({ link: link, section: section, top: 0 });
    });
    if (!items.length) return;

    var current = -1;
    var ticking = false;

    function measure() {
      var offset = window.pageYOffset || document.documentElement.scrollTop;
      items.forEach(function (item) {
        item.top = item.section.getBoundingClientRect().top + offset;
      });
    }

    function paint() {
      ticking = false;
      var y = (window.pageYOffset || document.documentElement.scrollTop) + window.innerHeight * 0.35;
      var atEnd = window.innerHeight + window.pageYOffset >= document.body.scrollHeight - 4;
      var index = 0;
      for (var i = 0; i < items.length; i++) {
        if (items[i].top <= y) index = i;
      }
      if (atEnd) index = items.length - 1;
      if (index === current) return;
      current = index;
      var link = items[index].link;
      dot.style.transform = "translateX(" + (link.offsetLeft + link.offsetWidth / 2 - 2) + "px)";
      dot.style.opacity = "1";
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(paint);
    }

    function onResize() {
      measure();
      current = -1;
      paint();
    }

    measure();
    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("load", onResize);
  });

  /* ------------------------------------------------------------------ *
   * Detail overlays
   * ------------------------------------------------------------------ */

  var ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>';

  var BAND_PATTERN =
    '<svg class="ov-band-pattern" viewBox="0 0 600 180" preserveAspectRatio="none" aria-hidden="true">' +
    '<path d="M-20 46C60 6 120 86 200 51S360 6 440 46 600 96 640 61"/>' +
    '<path d="M-20 106C60 66 120 146 200 111S360 66 440 106 600 156 640 121"/>' +
    '<path d="M-20 166C60 126 120 206 200 171S360 126 440 166 600 216 640 181"/>' +
    "</svg>";

  var SPARK =
    '<svg class="ov-band-mark" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 2.2 14 8.6l6.4 2-6.4 2-2 6.4-2-6.4-6.4-2 6.4-2z"/></svg>';

  var DETAIL = {
    "project/playai": {
      title: "PlayAI",
      meta: "C#, Python, Unity",
      image: "./playai.jpg",
      fit: "cover",
      body: [
        "PlayAI turns a single text prompt into a playable Unity 2D game. From that one input it writes the C# gameplay scripts and generates the textures and the scene assets.",
        "Python generation pipelines validate the model authored code, compile it, and load it into an executable build. The output is a game you can run, not a code sample."
      ],
      tags: ["C#", "Python", "Unity", "LLMs"],
      link: "https://github.com/HarshithMulakala/PlayAI",
      cta: "VIEW ON GITHUB"
    },
    "project/clipthat": {
      title: "ClipThat!",
      meta: "Swift, iOS. Live on the App Store",
      image: "./ClipThatIcon.png",
      fit: "contain",
      body: [
        "ClipThat is live on the App Store. It keeps a rolling buffer of audio on the device, so the moment you just missed is still there.",
        "One tap saves the previous 30 to 60 seconds. The app is privacy first. Nothing leaves the phone and there is zero cloud storage."
      ],
      tags: ["Swift", "iOS", "On device audio"],
      link: "https://apps.apple.com/us/app/clipthat/id6756780428",
      cta: "APP STORE"
    },
    "project/heymom": {
      title: "HeyMom",
      meta: "React Native, Python, FastAPI, WebSockets, Deepgram",
      image: "./heymom.svg",
      fit: "contain",
      body: [
        "HeyMom is a real time voice agent. Press to talk audio streams from an Expo client over WebSockets to a FastAPI server, which transcribes it live.",
        "Deepgram handles speech to text and Aura 2 handles speech synthesis. The server streams the synthesized audio back in chunks, so playback starts before the answer is complete."
      ],
      tags: ["React Native", "FastAPI", "WebSockets", "Deepgram"],
      link: "https://github.com/HarshithMulakala",
      cta: "VIEW ON GITHUB"
    },
    "project/qbot": {
      title: "Q Bot",
      meta: "Node.js, JavaScript, Discord.js",
      image: "./qbot.svg",
      fit: "contain",
      body: [
        "Q Bot is a voice controlled Discord bot. It listens inside a live voice channel and recognizes spoken commands.",
        "From voice alone it searches for a track, adds it to the queue, and streams the music back into the channel. Nobody has to type a command."
      ],
      tags: ["Node.js", "JavaScript", "Discord.js"],
      link: "https://github.com/HarshithMulakala/ReaderBot",
      cta: "VIEW ON GITHUB"
    },
    "project/currycal": {
      title: "CurryCal",
      meta: "Python, computer vision",
      image: "./currycal.png",
      fit: "contain",
      body: [
        "CurryCal is a calorie tracking app for South Asian food.",
        "It counts calories from a photo of the plate. The model is trained on regional dishes that generic food trackers do not recognize."
      ],
      tags: ["Python", "Computer vision", "Mobile"],
      link: "https://github.com/HarshithMulakala/CuryCalAI",
      cta: "VIEW ON GITHUB"
    },
    "project/resolutions": {
      title: "5 Minute Resolutions",
      meta: "Swift, iOS. Live on the App Store",
      image: "./resolutionsicon.png",
      fit: "contain",
      body: [
        "An iOS app for setting resolutions and then tracking real progress against them.",
        "The daily check in takes five minutes. That limit is the whole design, because a plan you cannot keep up with is not a plan."
      ],
      tags: ["Swift", "iOS", "Habit tracking"],
      link: "https://apps.apple.com/us/app/5-minute-resolutions/id6756897215",
      cta: "APP STORE"
    },
    "project/bulletbounce": {
      title: "Bullet Bounce",
      meta: "Unity, C#. Built for a game jam",
      image: "./bulletbounce.png",
      fit: "contain",
      pixel: true,
      body: [
        "A 2D puzzle game built for DonkeyClick during a mini game jam. You fire one bullet and then aim it back into yourself.",
        "The C# gameplay code covers bullet trajectory physics, collision detection, and the player interactions that make each level solvable in exactly one shot."
      ],
      tags: ["Unity", "C#", "Game design"],
      link: "https://cert.itch.io/bullet-bounce",
      cta: "VISIT PROJECT"
    },

    "role/majestic-turbo": {
      band: "Majestic Turbo",
      title: "AI Engineer Intern",
      meta: "Jul 2026 to Aug 2026 &nbsp;/&nbsp; Dallas, TX",
      body: [
        "Built five internal AI tools for the business. They include an inventory management system and an executive command center that delegates tasks to sales reps and tracks shipments.",
        "Built a late shipment prediction tool and a call recording pipeline. The pipeline transcribes sales calls, summarizes them with LLMs, and writes each summary to the rep record in the CRM.",
        "Built a marketing analytics dashboard and a lead generation tool on the Exa Search API and the Google Places API."
      ],
      tags: ["LLMs", "Exa Search API", "Google Places API", "CRM automation"]
    },
    "role/basics": {
      band: "Basics",
      title: "Founder and CTO",
      meta: "Jan 2026 to Jul 2026 &nbsp;/&nbsp; San Francisco, CA",
      body: [
        "Basics is a self hosted company operating system for early stage startups. It unifies CRM, projects, documents, analytics, and automations in one product.",
        "The stack is Next.js, TypeScript, Node.js, PostgreSQL, Docker, and AWS. Development is open, with four contributors on the repository.",
        "The platform has multi tenant RBAC, event driven workflows, real time sync, and containerized deployments that each customer manages.",
        "Ran more than 50 founder interviews and closed four paid pilots in 20 days. Raised a $1M pre seed at a $10M valuation."
      ],
      tags: ["Next.js", "TypeScript", "PostgreSQL", "Docker", "AWS"],
      link: "https://github.com/Basics-Vault/basicsOS",
      cta: "VIEW ON GITHUB"
    },
    "role/speakl": {
      band: "Speakl Inc.",
      title: "Co-Founder and CTO",
      meta: "Jun 2025 to Dec 2025 &nbsp;/&nbsp; Frisco, TX",
      body: [
        "Speakl is an AI communication platform. It gives multimodal feedback on public speaking and on interview answers.",
        "Built the product on React and FastAPI. It reached 1.5K lifetime users and 300 monthly active users, with custom computer vision, audio, and NLP pipelines.",
        "The AWS infrastructure served more than 15K API requests each month at 99% uptime, on S3, DynamoDB, IAM, auto scaling, and CloudWatch.",
        "Led four engineers. Set up CI/CD and shipped more than 50 production deployments. The system analyzed more than 500 hours of speech across more than 10 metrics."
      ],
      tags: ["React", "FastAPI", "AWS", "Computer vision", "NLP"],
      link: "https://speakl.ai",
      cta: "VISIT SITE"
    },
    "role/acm": {
      band: "ACM Research",
      title: "Head Researcher, AdFusion",
      meta: "Sep 2024 to Dec 2024 &nbsp;/&nbsp; Richardson, TX",
      body: [
        "Led AdFusion. Fine tuned Stable Diffusion and LLMs on more than 5,000 advertisement images, with preprocessing, augmentation, and output validation at each step.",
        "Built Python and Selenium scrapers that collected more than 3,000 ads from more than 10 platforms at 95% consistency."
      ],
      tags: ["Stable Diffusion", "Python", "Selenium"],
      link: "https://github.com/AakristG/AdFusion",
      cta: "VIEW ON GITHUB"
    },
    "role/itallentii": {
      band: "iTallentii Tech",
      title: "SWE Intern and Consultant",
      meta: "Nov 2022 to Jan 2023 &nbsp;/&nbsp; Frisco, TX",
      body: [
        "Built JavaScript and Node.js web scraping pipelines across more than 20 public sources. Manual data collection time dropped by 80%.",
        "Built a React front end on RESTful Node.js APIs. Returned later as a consultant to build katars.com and a set of internal tools."
      ],
      tags: ["Node.js", "React", "Web scraping"]
    },
    "role/donkeyclick": {
      band: "DonkeyClick",
      title: "Co-Founder and Lead Developer",
      meta: "Indie game studio &nbsp;/&nbsp; Unity and C#",
      body: [
        "An indie game studio that I founded with two friends. It ships mobile and PC games, including Bullet Bounce and Bombkey Thief.",
        "Main software developer on every project. All of the games are built in Unity with C#, from gameplay systems through to release."
      ],
      tags: ["Unity", "C#", "Game development"]
    },
    "role/cashonomics": {
      band: "Cashonomics",
      title: "Web Developer and Student Advisory Board",
      meta: "Student led nonprofit &nbsp;/&nbsp; Financial literacy",
      body: [
        "Cashonomics is a student led nonprofit for financial literacy. Built the full website, front end and back end.",
        "Added a Firebase backed blog system so that admins publish content directly, with no developer in the loop. Also advise the organization on technology as a member of the Student Advisory Board."
      ],
      tags: ["Firebase", "SCSS", "JavaScript"],
      link: "http://shahs-website.vercel.app/",
      cta: "VISIT SITE"
    }
  };

  guard(function () {
    var overlay = document.getElementById("overlay");
    var inner = document.getElementById("ov-inner");
    if (!overlay || !inner) return;

    var panel = overlay.querySelector(".ov-panel");
    var closeBtn = overlay.querySelector(".ov-close");
    var openKey = null;
    var opener = null;
    var pushed = false;
    var closeTimer = null;

    function escape(text) {
      return String(text).replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z]+);)/gi, "&amp;")
        .replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function render(item) {
      var html = "";

      if (item.image) {
        html += '<div class="ov-media' + (item.fit === "contain" ? " is-contain" : "") +
          (item.pixel ? " is-pixel" : "") + '">' +
          '<img src="' + item.image + '" alt="' + escape(item.title) + '" />' +
          "</div>";
      } else {
        html += '<div class="ov-band">' + BAND_PATTERN +
          '<span class="ov-band-name">' + escape(item.band) + "</span>" + SPARK + "</div>";
      }

      html += '<h2 class="ov-title" id="ov-title">' + escape(item.title) + "</h2>";
      html += '<p class="ov-meta">' + item.meta + "</p>";

      html += '<div class="ov-body">';
      item.body.forEach(function (para) { html += "<p>" + escape(para) + "</p>"; });
      html += "</div>";

      if (item.tags && item.tags.length) {
        html += '<ul class="chips ov-chips">';
        item.tags.forEach(function (tag) { html += "<li>" + escape(tag) + "</li>"; });
        html += "</ul>";
      }

      if (item.link) {
        html += '<a class="ov-cta" href="' + item.link + '" target="_blank" rel="noopener">' +
          escape(item.cta || "VISIT PROJECT") + ARROW + "</a>";
      }

      inner.innerHTML = html;
      inner.scrollTop = 0;
    }

    function lock() {
      var gap = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = "hidden";
      if (gap > 0) document.body.style.paddingRight = gap + "px";
    }

    function unlock() {
      document.body.style.overflow = "";
      document.body.style.paddingRight = "";
    }

    function open(key, fromRow) {
      var item = DETAIL[key];
      if (!item || openKey === key) return;
      if (closeTimer) { window.clearTimeout(closeTimer); closeTimer = null; }
      openKey = key;
      opener = fromRow || null;
      render(item);
      overlay.classList.remove("is-closing");
      overlay.classList.add("is-open");
      lock();
      void overlay.offsetWidth;
      overlay.classList.add("is-visible");
      panel.focus();
    }

    function finish() {
      overlay.classList.remove("is-open", "is-closing");
      inner.innerHTML = "";
      unlock();
      if (opener) { opener.focus(); opener = null; }
    }

    function close() {
      if (!openKey) return;
      openKey = null;
      overlay.classList.add("is-closing");
      overlay.classList.remove("is-visible");
      if (closeTimer) window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(function () { closeTimer = null; finish(); }, 260);
    }

    /* Back button, hash routes and deep links all run through the hash. */
    function keyFromHash() {
      var hash = window.location.hash.replace(/^#/, "");
      return DETAIL[hash] ? hash : null;
    }

    function sync(fromRow) {
      var key = keyFromHash();
      if (key) open(key, fromRow);
      else close();
    }

    function requestClose() {
      if (!openKey) return;
      if (pushed && window.history.length > 1) {
        pushed = false;
        window.history.back();
      } else {
        pushed = false;
        if (window.history.replaceState) {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
        close();
      }
    }

    document.addEventListener("click", function (event) {
      if (event.defaultPrevented) return;

      var row = event.target.closest ? event.target.closest("[data-detail]") : null;
      if (row) {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        var key = row.getAttribute("data-detail");
        if (!DETAIL[key]) return;
        event.preventDefault();
        pushed = true;
        if (window.location.hash === "#" + key) open(key, row);
        else {
          window.location.hash = key;
          open(key, row);
        }
        return;
      }

      if (overlay.classList.contains("is-open") &&
        event.target.closest && event.target.closest("[data-close]") &&
        !event.target.closest(".ov-panel")) {
        requestClose();
      }
    });

    closeBtn.addEventListener("click", requestClose);

    document.addEventListener("keydown", function (event) {
      if (!overlay.classList.contains("is-open")) return;

      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }

      if (event.key !== "Tab") return;
      var focusable = panel.querySelectorAll("a[href], button, [tabindex='-1']");
      var list = Array.prototype.filter.call(focusable, function (el) {
        return el.offsetParent !== null || el === panel;
      });
      if (!list.length) return;
      var first = list[0];
      var last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    window.addEventListener("hashchange", function () { sync(null); });

    sync(null);
  });

  /* ------------------------------------------------------------------ *
   * Custom cursor. Fine pointers only, off under reduced motion.
   * ------------------------------------------------------------------ */

  guard(function () {
    if (!finePointer.matches || reduce.matches) return;

    var root = document.documentElement;
    var ring = document.createElement("div");
    var dot = document.createElement("div");
    ring.className = "cursor-ring";
    dot.className = "cursor-dot";
    ring.setAttribute("aria-hidden", "true");
    dot.setAttribute("aria-hidden", "true");
    document.body.appendChild(ring);
    document.body.appendChild(dot);
    root.classList.add("custom-cursor");

    var HIT = "a[href], button, .row, [role='button'], summary";
    var TEXT = "input, textarea";

    var mx = window.innerWidth / 2;
    var my = window.innerHeight / 2;
    var rx = mx;
    var ry = my;
    var ringScale = 1;
    var dotScale = 1;
    var ringTarget = 1;
    var dotTarget = 1;
    var running = false;
    var live = false;

    function frame() {
      rx += (mx - rx) * 0.19;
      ry += (my - ry) * 0.19;
      ringScale += (ringTarget - ringScale) * 0.18;
      dotScale += (dotTarget - dotScale) * 0.22;

      ring.style.transform = "translate3d(" + rx + "px," + ry + "px,0) scale(" + ringScale + ")";
      dot.style.transform = "translate3d(" + mx + "px," + my + "px,0) scale(" + dotScale + ")";

      var settled = Math.abs(mx - rx) < 0.15 && Math.abs(my - ry) < 0.15 &&
        Math.abs(ringTarget - ringScale) < 0.005 && Math.abs(dotTarget - dotScale) < 0.005;
      if (settled) {
        rx = mx;
        ry = my;
        ringScale = ringTarget;
        dotScale = dotTarget;
        ring.style.transform = "translate3d(" + rx + "px," + ry + "px,0) scale(" + ringScale + ")";
        dot.style.transform = "translate3d(" + mx + "px," + my + "px,0) scale(" + dotScale + ")";
        running = false;
        return;
      }
      window.requestAnimationFrame(frame);
    }

    function start() {
      if (running) return;
      running = true;
      window.requestAnimationFrame(frame);
    }

    document.addEventListener("mousemove", function (event) {
      mx = event.clientX;
      my = event.clientY;
      if (!live) {
        live = true;
        rx = mx;
        ry = my;
        root.classList.add("cursor-live");
      }

      var target = event.target;
      var overText = target.closest ? !!target.closest(TEXT) : false;
      root.classList.toggle("cursor-text", overText);

      var overHit = !overText && target.closest ? !!target.closest(HIT) : false;
      ringTarget = overHit ? 1.6 : 1;
      dotTarget = overHit ? 0.7 : 1;

      start();
    }, { passive: true });

    document.addEventListener("mouseleave", function () {
      root.classList.remove("cursor-live");
      live = false;
    });

    document.addEventListener("mouseenter", function () {
      if (!live) return;
      root.classList.add("cursor-live");
    });

    window.addEventListener("blur", function () {
      root.classList.remove("cursor-live");
      live = false;
    });
  });
})();
