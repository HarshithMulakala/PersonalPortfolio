// data.js
// Single source of truth for all site content. Consumed by ui.js for both the
// classic scrolling page and the in voyage chapter panels. Copy is verbatim from
// the approved content brief. No em dashes anywhere.

export const SITE = {
  meta: {
    title: "Harshith Mulakala | Founder and Full-Stack Engineer",
    description:
      "Founder and full-stack engineer. I build AI products, ship iOS apps, and founded Basics. Sail through my work or read the classic version.",
    canonical: "https://www.harshithm.com/",
    ogImage: "./image.png",
    favicon: "./HM.png"
  },

  hero: {
    name: "HARSHITH MULAKALA",
    identity: "Founder and full-stack engineer building AI products that ship.",
    epithets: [
      "Founder and Full-Stack Engineer",
      "Builder of AI Products",
      "Game Developer and Designer",
      "Systems Architect",
      "Maker of Things That Ship"
    ],
    primaryCta: "Begin the voyage",
    secondaryCta: "View the classic version",
    fallbackPrimaryCta: "View my work",
    fallbackSecondaryCta: "Launch the voyage anyway",
    resume: "./resume.pdf"
  },

  // Island order matters. ids are the shared contract keys used by openPanel and voyage.js.
  chapters: [
    { id: "origins", name: "Origins", tag: "About" },
    { id: "forge", name: "The Forge", tag: "Skills" },
    { id: "labors", name: "The Labors", tag: "Projects" },
    { id: "voyages", name: "The Voyages", tag: "Experience" },
    { id: "oracle", name: "The Oracle", tag: "Contact" }
  ],

  origins: {
    id: "origins",
    name: "Origins",
    tag: "About",
    epigraph: "Every voyage begins on a known shore.",
    body:
      "I am Harshith Mulakala, a founder and full-stack engineer. I founded Basics, a self-hosted operating system for early-stage startups, and raised a $1M pre-seed at a $10M valuation to build it. I turned down a Barclays quant SWE internship to make that bet. I lead software at Speakl, an AI speaking coach, ship iOS apps to the App Store, and build games in Unity and C#. I study computer science at the University of Texas at Dallas, where I hold a 3.9 GPA. I like hard problems and finished products. Get in touch and let us build something.",
    portrait: "./image.png",
    portraitAlt: "Harshith Mulakala",
    credibility: [
      "BS Computer Science, University of Texas at Dallas, August 2024 to May 2028, 3.9 GPA.",
      "Academic Excellence Scholarship, 2025.",
      "Certiport certified in Java, JavaScript, and Network Security."
    ]
  },

  // The Forge maps to the required SITE.skills key.
  skills: {
    id: "forge",
    name: "The Forge",
    tag: "Skills",
    epigraph: "Tools sharpened over many long nights.",
    groups: [
      {
        label: "Languages",
        items: ["Python", "TypeScript", "JavaScript", "Java", "C#", "Swift", "SQL", "HTML", "CSS"]
      },
      {
        label: "Frameworks and Runtime",
        items: ["Next.js", "React", "React Native", "Node.js", "Flask", "Electron"]
      },
      {
        label: "AI and Machine Learning",
        items: [
          "PyTorch",
          "LLM fine-tuning",
          "diffusion models",
          "NLP and behavioral analytics pipelines",
          "Gemini"
        ]
      },
      {
        label: "Game Development",
        items: ["Unity", "C#"]
      },
      {
        label: "Cloud, Data, and Infrastructure",
        items: ["AWS", "Docker", "PostgreSQL", "Supabase", "Firebase", "DynamoDB"]
      },
      {
        label: "Tools and Practice",
        items: ["Selenium", "Xcode", "Git", "multi-tenant RBAC", "event-driven and real-time systems"]
      }
    ]
  },

  labors: {
    id: "labors",
    name: "The Labors",
    tag: "Projects",
    epigraph: "The works, set down one by one."
  },

  projects: [
    {
      id: "speakl",
      title: "Speakl",
      link: "https://speakl.ai",
      image: "./SpeaklLogo.png",
      alt: "Speakl logo, an AI speaking coach",
      card:
        "A real-time AI speaking coach for interviews and presentations. It listens as you talk, then gives instant feedback on pacing, clarity, filler words, and confidence.",
      expanded:
        "Speakl analyzes your delivery live and turns it into coaching you can act on. As Head of Software, I build the full-stack web infrastructure and the Python analytics pipelines behind behavioral signals like eye contact, pacing, and gesture. NLP and ML models score interviews and presentations, with a focus on reliability and secure handling of user data."
    },
    {
      id: "keeps",
      title: "Keeps",
      link: "https://keeps.email",
      image: "./keeps-icon.svg",
      alt: "Keeps, email-native company intelligence",
      card:
        "Email-native company intelligence. Forward or CC a thread to Keeps and it captures decisions, open loops, owners, and deadlines, then drives reminders and approval-gated actions.",
      expanded:
        "Keeps turns email into company memory. Share a thread by forwarding or CCing keeps@keeps.email and it extracts open loops, decisions, owners, and deadlines, then generates reminders, drafts, and follow-ups behind approval gates. Permissioned capture means it only sees what you choose to share. Built AI-native for teams that run on agents."
    },
    {
      id: "resolutions",
      title: "5 Minute Resolutions",
      link: "https://apps.apple.com/us/app/5-minute-resolutions/id6756897215",
      image: "./resolutionsicon.png",
      alt: "5 Minute Resolutions app icon",
      card:
        "An iOS app for setting New Year's resolutions and tracking progress in a few minutes a day. Published on the App Store.",
      expanded:
        "5 Minute Resolutions keeps goal-setting small enough to stick with. You set resolutions, log progress, and watch streaks build over time. Designed and shipped as a native iOS app, available now on the App Store."
    },
    {
      id: "clipthat",
      title: "ClipThat!",
      link: "https://apps.apple.com/us/app/clipthat/id6756780428",
      image: "./ClipThatIcon.png",
      alt: "ClipThat! app icon",
      card:
        "An iOS app that always buffers the last 30 to 60 seconds of audio, so one tap saves the moment you just heard. Fully on-device, no cloud.",
      expanded:
        "ClipThat! runs a continuous on-device audio buffer, so you never miss a spontaneous conversation, idea, or quote. Tap once and the last 30 to 60 seconds are saved to your device, with zero cloud storage for privacy. Built in Swift and published to the App Store."
    },
    {
      id: "sml",
      title: "Social Media Lens",
      link: null,
      image: "./sml-icon.svg",
      alt: "Social Media Lens AI web app",
      card:
        "An AI web app built with Bank of America that gathers public social media posts by topic and timeframe, then analyzes trends and sentiment.",
      expanded:
        "Social Media Lens pulls public social posts by topic and date range, then runs them through automated pipelines to surface trends and sentiment. I built it with Bank of America using Python, Flask, and Selenium for collection, with Gemini driving the analysis. The result turns scattered public posts into a readable signal."
    },
    {
      id: "adfusion",
      title: "ACM Research: AdFusion",
      link: "https://github.com/AakristG/AdFusion",
      image: "./AdFusion.jpg",
      alt: "AdFusion generated ad creative sample",
      card:
        "An ACM Research project fine-tuning language and diffusion models to generate realistic ad creatives, captions, and visuals from a full custom data pipeline.",
      expanded:
        "As Head Researcher on AdFusion, I fine-tuned large language and diffusion models to produce advertising captions and imagery for marketing use cases. I built Selenium-based Python scrapers that collected and structured thousands of ads, with a focus on data quality and automation. The pipeline fed model training end to end."
    },
    {
      id: "playai",
      title: "PlayAI",
      link: "https://github.com/HarshithMulakala/PlayAI",
      image: "./playai.jpg",
      alt: "PlayAI logo",
      card:
        "A command-line tool that turns a text prompt into a playable Unity 2D game, generating scripts, textures, and assets automatically.",
      expanded:
        "PlayAI takes a plain-language description of a simple game and scaffolds a working 2D prototype in Unity. It generates scenes, prefabs, scripts, and textures, so you go from idea to playable in one step. Built to speed up early game experimentation."
    },
    {
      id: "currycal",
      title: "CurryCal",
      link: "https://github.com/HarshithMulakala/CuryCalAI",
      image: "./currycal.png",
      alt: "CurryCal app icon",
      card:
        "A calorie tracker built for South Asian food. Snap a photo of your meal and get an instant estimate tuned to regional dishes.",
      expanded:
        "CurryCal fixes calorie tracking for cuisines that generic apps get wrong. Take a picture of your plate and it estimates calories for regional South Asian dishes, so logging a meal takes seconds. An AI-powered tracker for food most apps overlook."
    },
    {
      id: "bulletbounce",
      title: "Bullet Bounce",
      link: "https://cert.itch.io/bullet-bounce",
      image: "https://img.itch.zone/aW1nLzk2MzA2MDgucG5n/315x250%23c/7ToN2z.png",
      alt: "Bullet Bounce game screenshot",
      card:
        "A 2D puzzle game where you fire a bullet and aim it back at yourself. Built in Unity and C# for a DonkeyClick game jam.",
      expanded:
        "Bullet Bounce is a compact puzzle-shooter: line up a shot so the bullet ricochets and hits your own character. I built the gameplay, physics, and collision logic in Unity and C# for a DonkeyClick game jam. Playable on itch.io."
    },
    {
      id: "qbot",
      title: "Q Bot",
      link: "https://github.com/HarshithMulakala/ReaderBot",
      image: "./qbot-icon.svg",
      alt: "Q Bot Discord bot icon",
      card:
        "A Discord bot in Node.js that handles voice-channel commands and music playback across multiple servers.",
      expanded:
        "Q Bot brings command handling and music to Discord voice channels. Built with Node.js and Discord.js, it plays, queues, and skips tracks and runs across several servers at once. A small, reliable utility kept always on."
    }
  ],

  voyages: {
    id: "voyages",
    name: "The Voyages",
    tag: "Experience",
    epigraph: "Ports of call, and what each one taught."
  },

  experience: [
    {
      id: "basics",
      title: "Basics",
      role: "Founder and CTO",
      location: "San Francisco, CA",
      dates: "January 2026 to July 2026",
      image: "./basics-icon.png",
      alt: "Basics logo",
      featured: true,
      card:
        "Founder and CTO of a self-hosted operating system for early-stage startups, replacing fragmented SaaS with one unified workspace. Raised a $1M pre-seed at a $10M valuation.",
      bullets: [
        "Raised a $1M pre-seed round at a $10M valuation, turning down a Barclays quant SWE internship offer to build the company full time.",
        "Architected a self-hosted startup operating system in Next.js, TypeScript, Node.js, PostgreSQL, Docker, and AWS, unifying CRM, projects, documents, analytics, and automations.",
        "Designed multi-tenant RBAC, event-driven workflows, real-time data synchronization, extensible API integrations, and containerized deployment for secure, customer-managed environments.",
        "Ran 50+ founder interviews and turned what I heard into product decisions, from the core workflows to build down to what to deliberately leave out."
      ]
    },
    {
      id: "speakl",
      title: "Speakl Inc.",
      role: "Head of Software",
      location: "Frisco, TX",
      dates: "June 2025 to Present",
      image: "./SpeaklLogo.png",
      alt: "Speakl logo",
      card:
        "Lead software for an AI speaking coach that scores interviews and presentations in real time.",
      bullets: [
        "Built and maintain full-stack web infrastructure focused on reliability, data integrity, and secure handling of user data.",
        "Developed Python analytics pipelines for behavioral signals including eye contact, pacing, and gesture.",
        "Work with NLP and ML systems to analyze interviews and presentations, iterating on output quality and monitoring."
      ]
    },
    {
      id: "adfusion",
      title: "ACM Research: AdFusion",
      role: "Head Researcher",
      location: "Richardson, TX",
      dates: "September 2024 to December 2024",
      image: "./AdFusion.jpg",
      alt: "AdFusion project",
      card:
        "Led a text-to-image research project generating advertising creatives with fine-tuned models.",
      bullets: [
        "Fine-tuned and trained large language and diffusion models, with structured dataset handling and validation of outputs.",
        "Built Selenium-based Python scrapers to collect and process thousands of ads, focused on data quality and automation."
      ]
    },
    {
      id: "italentii",
      title: "iTalentii Tech",
      role: "Intern",
      location: "Frisco, TX",
      dates: "November 2022 to January 2023",
      image: "./Logo.PNG",
      alt: "iTalentii Tech logo",
      card:
        "Full-stack intern building scraping and integration features for a deals-and-coupons app.",
      bullets: [
        "Built web scraping functionality for public sources using JavaScript and Node.js.",
        "Integrated frontend and backend with React and Node, focused on correct data flow and reliability."
      ]
    },
    {
      id: "donkeyclick",
      title: "DonkeyClick",
      role: "Co-founder and Lead Developer",
      location: "Indie game studio",
      dates: "",
      image: "./donkeyclick.png",
      alt: "DonkeyClick studio logo",
      card: "Co-founded a small indie studio shipping mobile and PC games.",
      bullets: [
        "Co-founded a three-person studio and led development across projects in Unity and C#.",
        "Shipped titles including Bullet Bounce, writing most of the gameplay code."
      ]
    },
    {
      id: "cashonomics",
      title: "Cashonomics",
      role: "Web Developer and Advisory Board Member",
      location: "Nonprofit",
      dates: "",
      image: "https://shahs-website.vercel.app/images/Cashonomics.png",
      alt: "Cashonomics logo",
      card:
        "Built the website and advised on technology for a student-led financial-literacy nonprofit.",
      bullets: [
        "Designed and built the organization's website front to back, including a Firebase-backed admin blog.",
        "Advised the team on technology and online presence as a student advisory board member."
      ]
    }
  ],

  // The Oracle maps to the required SITE.contact key.
  contact: {
    id: "oracle",
    name: "The Oracle",
    tag: "Contact",
    epigraph: "Speak, and I will answer.",
    heading: "Get in touch",
    invite:
      "Have a role, a project, or an idea worth building? Send word and I will get back to you.",
    form: {
      action: "https://formsubmit.co/dmrknife@gmail.com",
      method: "POST",
      hidden: {
        _subject: "Portfolio Contact",
        _cc: "harshithmbusiness@gmail.com",
        _next: "https://www.harshithm.com/"
      },
      emailPlaceholder: "Your email",
      messagePlaceholder: "What do you want to build?",
      submit: "Send message"
    },
    socials: [
      { name: "LinkedIn", url: "https://www.linkedin.com/in/harshith-mulakala-ba590823b/" },
      { name: "GitHub", url: "https://github.com/HarshithMulakala" },
      { name: "Instagram", url: "https://www.instagram.com/harshithmulakala/" }
    ]
  },

  micro: {
    dockDesktop: "Press E to dock",
    dockMobile: "Tap to dock",
    sailOnDesktop: "Press E to sail on",
    sailOnMobile: "Tap to sail on",
    welcome: "The sea is open. Choose your island.",
    loading: ["Charting the stars.", "Raising the sails.", "Reading the winds."],
    fallbackToggle: "View the classic version",
    hudViewAsPage: "View as page",
    relaunch: "Begin the voyage",
    controlsHintDesktop: "WASD or arrows to sail · Click an island to auto-route · E to dock",
    controlsHintMobile: "Drag to sail · Tap an island to auto-route · Tap to dock",
    panelClose: "Sail on",
    // Voyage 2.0 additive strings.
    firstHint: "Follow the amber line.",
    firstHintTouch: "Tap an island to sail there.",
    chartComplete: "The chart is complete. Fair winds.",
    sailingTo: "Sailing to {name}.",
    mutedDockHint: "Sound is off. Tap the sound button for the sea.",
    classicHint: "Prefer a simple page?",
    viewAsList: "View as list",
    beatPrev: "Previous",
    beatNext: "Next",
    beatMore: "More",
    beatLess: "Less",
    beatVisit: "Visit",
    soundOn: "Sound",
    soundOff: "Sound off",
    // Scroll map loader (award-site entry).
    entryStart: "Start Voyage",
    entryClassic: "View my work"
  },

  // Chart annotations for the scroll map loader. Short, verbatim from the brief.
  scrollBullets: [
    "Founder and CTO of Basics. Raised a $1M pre-seed at a $10M valuation.",
    "Turned down a Barclays quant SWE internship to make that bet.",
    "Head of Software at Speakl, an AI speaking coach.",
    "CS at UT Dallas, 3.9 GPA. Ships iOS apps to the App Store and builds games in Unity."
  ],

  attributions: [
    '<a href="https://poly.pizza/m/cdMQnl19MB9" target="_blank" rel="noopener noreferrer">Greek Temple</a> by Alexandre Thomas (CC BY 3.0)',
    '<a href="https://poly.pizza/m/5VD5-v8NBZ4" target="_blank" rel="noopener noreferrer">Doric Column</a> by Victor Vina (CC BY 3.0)',
    '<a href="https://poly.pizza/m/cPD0rM1BNc1" target="_blank" rel="noopener noreferrer">Greek Pillar</a> by Duncan Anderson (CC BY 3.0)',
    '<a href="https://poly.pizza/m/4PHDVmmfFj9" target="_blank" rel="noopener noreferrer">Cypress Tree</a> by Andrea Zvinakis (CC BY 3.0)',
    '<a href="https://poly.pizza/m/3gEvVZoTN7e" target="_blank" rel="noopener noreferrer">Lighthouse</a> by Robert Mirabelle (CC BY 3.0)',
    '<a href="https://poly.pizza/m/7Q8MkXjALbL" target="_blank" rel="noopener noreferrer">Amphora</a> by Bruno Oliveira (CC BY 3.0)',
    'Ship, boats, dock, and rocks by Quaternius and Kenney (CC0)'
  ]
};

// Chapter numerals for the compass, labels, and beat cards. Additive: does not
// alter any existing copy, only names the fixed order already in SITE.chapters.
SITE.numerals = {
  origins: "I",
  forge: "II",
  labors: "III",
  voyages: "IV",
  oracle: "V"
};

// Beat metadata for the diegetic docked tour. Each entry only REFERENCES existing
// copy (paragraphs, skill groups, projects, experience, contact form); ui.js
// resolves the real content so nothing here duplicates or changes it.
SITE.beats = {
  origins: [
    { kind: "about", part: 1, title: "Origins" },
    { kind: "about", part: 2, title: "Origins" },
    { kind: "credibility", title: "Credentials" }
  ],
  forge: [
    { kind: "skills", groups: [0, 1], title: "The Forge" },
    { kind: "skills", groups: [2, 3], title: "The Forge" },
    { kind: "skills", groups: [4, 5], title: "The Forge" }
  ],
  labors: SITE.projects.map((_, i) => ({ kind: "project", index: i })),
  voyages: SITE.experience.map((_, i) => ({ kind: "experience", index: i })),
  oracle: [
    { kind: "invite", title: "The Oracle" },
    { kind: "form", title: "Get in touch" }
  ]
};

export default SITE;
