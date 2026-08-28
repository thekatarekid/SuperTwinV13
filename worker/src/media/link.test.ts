// ===========================================================================
// Link scraping tests (vitest): the SSRF guard first, then HTML→text, then the
// fetch itself against a real loopback server.
//
// The guard is the reason this module exists, so it is tested two ways: the
// address table directly, and end to end through `scrapeLink` with the real
// system resolver — `localhost` is a hostname that resolves to a private
// address, which is exactly the case the guard is for, and the test server
// proves no request ever reached it.
//
// The fetch-path tests hand `scrapeLink` a narrower address policy, because the
// only server we can stand up is on loopback. The policy is still applied at
// connect time by the same code path production uses.
//
// The second subject is the bug in v6 §4: a body cut at the byte cap ends
// mid-<script>, and the extractor used to hand the orphan JavaScript back as
// prose. That case is served here as bytes — a script the server never closes —
// rather than asserted on a hand-written string, because the truncation is the
// bug and a tidy fixture would not reproduce it.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { setMediaWhisperModel } from "../db/settings.js";
import {
  assemble,
  extractTitle,
  htmlToText,
  instagramPost,
  isBlockedAddress,
  linkVideoContent,
  looksLikeProse,
  MAX_SCRAPED_CHARS,
  readPage,
  scrapeLink,
  videoLinkUrl,
  vttToText,
  youTubeCaptions,
  youTubeVideoId,
} from "./link.js";
import { resolveYtDlpBin, whisperModelsDir } from "./tools.js";

// The video cases spawn yt-dlp, ffmpeg and whisper stubs several times each,
// and vitest runs test files in parallel — the default five seconds measures
// the machine rather than this code. Every path underneath still carries its
// own deadline, so a genuine hang is still caught.
vi.setConfig({ testTimeout: 20_000 });

/** Loopback is only reachable in a test if the policy lets it through. */
const allowLoopback = { blocked: (a: string) => a !== "127.0.0.1" };

/** A shell word for a string this test wrote; nothing here comes from outside. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

let server: Server;
let base: string;
let hits: string[];
let tmpDir: string;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler = (_req, res) => res.end("ok");

beforeEach(async () => {
  hits = [];
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-link-"));
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  delete process.env.SUPERTWIN_YTDLP_BIN;
  delete process.env.SUPERTWIN_FFMPEG_BIN;
  delete process.env.SUPERTWIN_WHISPER_BIN;
  rmSync(tmpDir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("isBlockedAddress", () => {
  it("refuses every private, loopback, link-local and reserved IPv4 block", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud instance metadata
      "100.64.0.1",
      "0.0.0.0",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("refuses the IPv6 equivalents, including a v4 address wrapped in one", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:10.0.0.1", // IPv4-mapped
      "::ffff:127.0.0.1",
      "64:ff9b::192.168.0.1", // NAT64
      "2001:db8::1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("lets a public address through", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("refuses anything that is not an address at all", () => {
    for (const s of ["", "localhost", "1.2.3", "999.1.1.1", "nonsense"]) {
      expect(isBlockedAddress(s), s).toBe(true);
    }
  });
});

describe("the SSRF guard, end to end", () => {
  it("refuses a hostname that resolves to a private address, without connecting", async () => {
    const port = (server.address() as AddressInfo).port;
    const res = await scrapeLink(`http://localhost:${port}/secrets`);

    expect(res.status).toBe("skipped");
    expect(res.error).toContain("non-public addresses");
    expect(res.scrapedText).toBeNull();
    expect(hits).toEqual([]);
  });

  it("refuses a literal private address", async () => {
    const res = await scrapeLink(`${base}/secrets`);
    expect(res.status).toBe("skipped");
    expect(hits).toEqual([]);
  });

  it("re-checks every redirect hop", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://10.0.0.1/internal" });
      res.end();
    };
    const res = await scrapeLink(`${base}/start`, allowLoopback);

    expect(res.status).toBe("skipped");
    expect(res.error).toContain("non-public address");
  });

  it("refuses an IP literal, which never reaches the resolver at all", async () => {
    const res = await scrapeLink("http://169.254.169.254/latest/meta-data/");
    expect(res.status).toBe("skipped");
    expect(res.error).toContain("non-public address");
  });

  it("refuses a scheme it cannot fetch", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "data:text/html,<b>hi</b>",
      "not a url",
    ]) {
      const res = await scrapeLink(url);
      expect(res.status, url).toBe("skipped");
      expect(res.scrapedText, url).toBeNull();
    }
  });
});

describe("htmlToText", () => {
  it("drops script and style content rather than indexing code", () => {
    const text = htmlToText(
      `<html><head><title>T</title><style>body{color:red}</style></head>
       <body><script>var secret = 1;</script><p>Real words.</p></body></html>`,
    );
    expect(text).toBe("Real words.");
  });

  it("drops a script that never closes, instead of reading it as prose", () => {
    const text = htmlToText(
      `<html><body><p>Before.</p><script>var ytcfg = {"XSRF":"a\\u0026b",`,
    );
    expect(text).toBe("Before.");
  });

  it("drops an unclosed style, comment and tag at the truncation point", () => {
    expect(htmlToText("<p>Kept.</p><style>.a{color:red}")).toBe("Kept.");
    expect(htmlToText("<p>Kept.</p><!-- half a comme")).toBe("Kept.");
    expect(htmlToText('<p>Kept.</p><div class="x')).toBe("Kept.");
  });

  it("prefers the main content over the chrome around it", () => {
    const text = htmlToText(
      `<body><nav>Home About Contact</nav>
       <main><p>The article itself.</p></main>
       <footer>Cookies. Privacy. Terms.</footer></body>`,
    );
    expect(text).toBe("The article itself.");
  });

  it("reads an article element when there is no main", () => {
    expect(
      htmlToText("<body><nav>Skip</nav><article><p>Body copy.</p></article></body>"),
    ).toBe("Body copy.");
  });

  it("reads a main element the page never closed", () => {
    expect(htmlToText("<body><nav>Skip</nav><main><p>Half a page.")).toBe(
      "Half a page.",
    );
  });

  it("keeps block boundaries so sentences do not run together", () => {
    expect(htmlToText("<p>One.</p><p>Two.</p>")).toBe("One.\nTwo.");
    expect(htmlToText("a<br>b")).toBe("a\nb");
  });

  it("decodes entities", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &#8212; 5&nbsp;pm &#x2713;</p>")).toBe(
      "Tom & Jerry — 5 pm ✓",
    );
    expect(htmlToText("<p>5 Sept &middot; &copy; 2026 &mdash; 30&deg;</p>")).toBe(
      "5 Sept · © 2026 — 30°",
    );
  });

  it("leaves an entity it does not know rather than guessing at it", () => {
    expect(htmlToText("<p>&thetasym; is not in the table</p>")).toBe(
      "&thetasym; is not in the table",
    );
  });

  it("caps a long page", () => {
    const text = htmlToText(`<p>${"word ".repeat(5000)}</p>`);
    expect(text.length).toBeLessThanOrEqual(MAX_SCRAPED_CHARS);
  });
});

describe("extractTitle", () => {
  it("reads the page title and decodes it", () => {
    expect(extractTitle('<title id="t">Rates &amp; risk</title>')).toBe(
      "Rates & risk",
    );
  });

  it("is null when there is none", () => {
    expect(extractTitle("<p>no title here</p>")).toBeNull();
  });
});

describe("readPage", () => {
  it("prefers og: over the page title and the body", () => {
    const page = readPage(
      `<html><head><title>Reel by kabir • Instagram</title>
        <meta property="og:title" content="kabir on Instagram: &quot;last light&quot;">
        <meta property="og:description" content="1,204 likes, 63 comments — kabir on 4 May: last light over the bay.">
       </head><body><div id="mount"></div></body></html>`,
    );
    expect(page.title).toBe('kabir on Instagram: "last light"');
    expect(assemble(page.parts).text).toBe(
      "1,204 likes, 63 comments — kabir on 4 May: last light over the bay.",
    );
  });

  it("falls back through twitter: and name=description", () => {
    const page = readPage(
      `<head><meta name="twitter:title" content="Rates hold">
       <meta name="description" content="The committee left rates unchanged."></head>`,
    );
    expect(page.title).toBe("Rates hold");
    expect(assemble(page.parts).text).toBe("The committee left rates unchanged.");
  });

  it("reads a JSON-LD VideoObject when the page has no og: tags", () => {
    const page = readPage(
      `<head><script type="application/ld+json">
        {"@context":"https://schema.org","@graph":[
          {"@type":"WebPage"},
          {"@type":"VideoObject","name":"But what is a neural network?",
           "description":"Neurons, layers, and the maths under them."}]}
       </script></head><body></body>`,
    );
    expect(page.title).toBe("But what is a neural network?");
    expect(assemble(page.parts).text).toBe(
      "Neurons, layers, and the maths under them.",
    );
  });

  it("ignores a JSON-LD block the byte budget cut in half", () => {
    const page = readPage(
      `<head><script type="application/ld+json">
        {"@type":"VideoObject","name":"Half a video","descrip`,
    );
    expect(page.title).toBeNull();
    expect(assemble(page.parts).text).toBe("");
  });

  it("leaves the site a video page renders around its player", () => {
    const page = readPage(
      `<head><meta property="og:type" content="video.other">
       <meta property="og:description" content="Neurons, layers, and the maths under them."></head>
       <body><div id="app"></div>
       <div>About Press Copyright Contact us Creators Advertise Developers Terms</div></body>`,
    );
    expect(assemble(page.parts).text).toBe(
      "Neurons, layers, and the maths under them.",
    );
  });

  it("keeps the body of an ordinary page that marks no content region", () => {
    const page = readPage(
      `<head><meta name="description" content="Empowering everyone."></head>
       <body><nav>Home Blog</nav><div><p>Rust 1.81 stabilises the sort algorithms.</p></div></body>`,
    );
    expect(assemble(page.parts).text).toBe(
      "Empowering everyone.\nRust 1.81 stabilises the sort algorithms.",
    );
  });

  it("keeps the description and the article, and never repeats itself", () => {
    const page = readPage(
      `<head><meta property="og:description" content="Ferries run hourly."></head>
       <body><main><p>Ferries run hourly.</p><p>The last one leaves at 9.</p></main></body>`,
    );
    expect(assemble(page.parts).text).toBe(
      "Ferries run hourly.\nThe last one leaves at 9.",
    );
  });
});

describe("looksLikeProse", () => {
  it("accepts sentences, in any script", () => {
    for (const s of [
      "Revenue rose 12%.",
      "Arrived.",
      "1,204 likes, 63 comments — kabir on 4 May.",
      "यह 3 है. इसे बेहद कम रिज़ॉल्यूशन पर लिखा गया है.",
      'She said "no" and then "yes".',
    ]) {
      expect(looksLikeProse(s), s).toBe(true);
    }
  });

  it("refuses the code a truncated page leaks", () => {
    for (const s of [
      `{"require":[["ScheduledServerJS",[],[],[]]]}`,
      `var ytcfg = {};ytcfg.set({"CLIENT_VERSION":"2.2024"});`,
      `window.ytInitialData = {"contents":{"twoColumn":{}}};`,
      `(function(a,b){return a.c[b]||(a.c[b]={})})(w,"x");`,
      `\\u0026amp\\u003b\\u0026quot\\u003b\\u0026lt\\u003b`,
      "))))))",
    ]) {
      expect(looksLikeProse(s), s).toBe(false);
    }
  });

  it("refuses a long run with no word boundaries", () => {
    expect(looksLikeProse("a".repeat(400))).toBe(false);
  });
});

describe("assemble", () => {
  it("reports that it threw something away, so an empty result is not silence", () => {
    expect(assemble([`{"require":[["a",[],[]]]}`])).toEqual({
      text: "",
      dropped: true,
    });
    expect(assemble([null, "  "])).toEqual({ text: "", dropped: false });
  });

  it("keeps the prose and drops the code beside it", () => {
    const { text, dropped } = assemble(["A real sentence.", `{"a":[[1,2],[3,4]]}`]);
    expect(text).toBe("A real sentence.");
    expect(dropped).toBe(true);
  });

  it("caps the whole block, so the metadata cannot be pushed out by captions", () => {
    const { text } = assemble(["First line.", "word ".repeat(5000)]);
    expect(text.startsWith("First line.\n")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_SCRAPED_CHARS);
  });
});

describe("youTubeVideoId", () => {
  it("reads the id off every shape YouTube hands out", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=aircAruvnKk",
      "https://www.youtube.com/watch?app=desktop&v=aircAruvnKk&t=30s",
      "https://m.youtube.com/watch?v=aircAruvnKk",
      "https://music.youtube.com/watch?v=aircAruvnKk",
      "https://youtu.be/aircAruvnKk?si=abc",
      "https://www.youtube.com/shorts/aircAruvnKk",
      "https://www.youtube.com/embed/aircAruvnKk",
      "https://www.youtube.com/live/aircAruvnKk",
    ]) {
      expect(youTubeVideoId(new URL(url)), url).toBe("aircAruvnKk");
    }
  });

  it("is null for anything that is not a YouTube video", () => {
    for (const url of [
      "https://youtube.com.attacker.example/watch?v=aircAruvnKk",
      "https://notyoutube.com/watch?v=aircAruvnKk",
      "https://www.youtube.com/watch?v=../../etc/passwd",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/@3blue1brown",
      "https://www.instagram.com/reel/C1a2b3c4d5e/",
    ]) {
      expect(youTubeVideoId(new URL(url)), url).toBeNull();
    }
  });
});

describe("instagramPost", () => {
  it("reads the shortcode off the shapes Instagram hands out", () => {
    for (const [url, kind] of [
      ["https://www.instagram.com/reel/C1a2b3c4d5e/", "reel"],
      ["https://instagram.com/reels/C1a2b3c4d5e/", "reel"],
      ["https://www.instagram.com/p/C1a2b3c4d5e/?img_index=1", "p"],
      ["https://www.instagram.com/tv/C1a2b3c4d5e/", "tv"],
      // A reel under its author's profile is the same reel.
      ["https://www.instagram.com/someone/reel/C1a2b3c4d5e/", "reel"],
    ] as const) {
      expect(instagramPost(new URL(url)), url).toEqual({
        kind,
        code: "C1a2b3c4d5e",
      });
    }
  });

  it("is null for anything that is not an Instagram video page", () => {
    for (const url of [
      "https://instagram.com.attacker.example/reel/C1a2b3c4d5e/",
      "https://notinstagram.com/reel/C1a2b3c4d5e/",
      "https://www.instagram.com/reel/../../etc/passwd",
      "https://www.instagram.com/someone/",
      "https://www.instagram.com/stories/someone/",
      "https://www.youtube.com/watch?v=aircAruvnKk",
    ]) {
      expect(instagramPost(new URL(url)), url).toBeNull();
    }
  });
});

describe("videoLinkUrl", () => {
  // yt-dlp fetches whatever it is pointed at, so what it is pointed at is
  // rebuilt from the id — never the string that arrived in the message.
  it("rebuilds a canonical URL out of what it recognised", () => {
    expect(videoLinkUrl(new URL("https://youtu.be/aircAruvnKk?si=x&t=90"))).toBe(
      "https://www.youtube.com/watch?v=aircAruvnKk",
    );
    expect(
      videoLinkUrl(new URL("https://www.instagram.com/someone/reels/C1a2b3c4d5e/?hl=en")),
    ).toBe("https://www.instagram.com/reel/C1a2b3c4d5e/");
  });

  it("is null for a page that is not a video", () => {
    expect(videoLinkUrl(new URL("https://example.com/article"))).toBeNull();
  });
});

describe("vttToText", () => {
  it("keeps the words and drops the scaffolding", () => {
    expect(
      vttToText(
        [
          "WEBVTT",
          "Kind: captions",
          "Language: en",
          "",
          "1",
          "00:00:04.220 --> 00:00:05.400",
          "This is a <c>3</c>.",
          "",
          "00:00:06.060 --> 00:00:10.713 align:start position:0%",
          "Rendered at 28x28 pixels &amp; still legible.",
          "",
        ].join("\n"),
      ),
    ).toBe("This is a 3. Rendered at 28x28 pixels & still legible.");
  });

  it("collapses the repeats an auto-generated track is made of", () => {
    expect(
      vttToText(
        [
          "WEBVTT",
          "",
          "00:00:00.000 --> 00:00:01.000",
          "so the first thing",
          "",
          "00:00:01.000 --> 00:00:02.000",
          "so the first thing",
          "",
          "00:00:02.000 --> 00:00:03.000",
          "we do is",
          "",
        ].join("\n"),
      ),
    ).toBe("so the first thing we do is");
  });
});

describe("youTubeCaptions", () => {
  /** A yt-dlp that records its argv and writes the track it was asked for. */
  function stubYtDlp(vtt: string | null): string {
    const path = join(tmpDir, "yt-dlp");
    const argv = join(tmpDir, "argv.txt");
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > ${JSON.stringify(argv)}`,
        'out=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done',
        vtt === null
          ? "exit 1"
          : `[ -n "$out" ] && cat > "$(printf '%s' "$out" | sed 's/%(ext)s/en.vtt/')" <<'VTT'\n${vtt}\nVTT`,
        "exit 0",
      ].join("\n"),
    );
    chmodSync(path, 0o755);
    process.env.SUPERTWIN_YTDLP_BIN = path;
    return argv;
  }

  it("returns the caption text of the track it downloaded", async () => {
    stubYtDlp("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSpoken words.\n");
    expect(await youTubeCaptions("aircAruvnKk", "creator")).toBe("Spoken words.");
  });

  it("asks for one video by id, with no cookies and no config", async () => {
    const argvPath = stubYtDlp("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi.\n");
    await youTubeCaptions("aircAruvnKk", "creator");
    const argv = readFileSync(argvPath, "utf8").trim().split("\n");

    // The URL is rebuilt from the id, so nothing of the sender's string is
    // handed to a program that fetches what it is pointed at.
    expect(argv).toContain("https://www.youtube.com/watch?v=aircAruvnKk");
    expect(argv).toContain("--no-config");
    expect(argv).toContain("--skip-download");
    expect(argv).toContain("--no-playlist");
    expect(argv.some((a) => /cookie/i.test(a))).toBe(false);
    // One argv element per flag: nothing was ever a command string.
    expect(argv).toContain("--sub-langs");
    expect(argv[argv.indexOf("--sub-langs") + 1]).toBe("en,hi,mr");
  });

  // v7 §4 ranks a person's own subtitles above any ASR, which is only a
  // ranking if the two are asked for separately.
  it("asks for exactly one kind of track per run", async () => {
    const argvPath = stubYtDlp("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi.\n");

    await youTubeCaptions("aircAruvnKk", "creator");
    let argv = readFileSync(argvPath, "utf8").trim().split("\n");
    expect(argv).toContain("--write-subs");
    expect(argv).not.toContain("--write-auto-subs");

    await youTubeCaptions("aircAruvnKk", "auto");
    argv = readFileSync(argvPath, "utf8").trim().split("\n");
    expect(argv).toContain("--write-auto-subs");
    expect(argv).not.toContain("--write-subs");
  });

  it("is null when yt-dlp fails, so the page's own metadata still stands", async () => {
    stubYtDlp(null);
    expect(await youTubeCaptions("aircAruvnKk", "creator")).toBeNull();
  });

  it("is null when yt-dlp was never staged", async () => {
    process.env.SUPERTWIN_YTDLP_BIN = join(tmpDir, "absent");
    expect(resolveYtDlpBin()).toBeNull();
    expect(await youTubeCaptions("aircAruvnKk", "creator")).toBeNull();
  });
});

// The order v7 §4 fixes — a person's own subtitles, then whisper over the
// downloaded file, then YouTube's ASR — is the whole point of the section, and
// it is invisible in any single outcome. So each source is stubbed to say
// something only it could have said, and the test reads which one won.
describe("linkVideoContent", () => {
  const YOUTUBE = new URL("https://www.youtube.com/watch?v=aircAruvnKk");
  const CREATOR = "The subtitles the creator uploaded.";
  const AUTO = "the words youtube s robot heard";
  const WHISPER = "aaj hum log ek nayi recipe banane wale hain dosto";

  let toolCalls: string;

  beforeEach(() => {
    toolCalls = join(tmpDir, "calls.txt");
    process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
    process.env.SUPERTWIN_HOME = join(tmpDir, "home");
    process.env.SUPERTWIN_MEDIA_DIR = join(tmpDir, "media");
    closeDb();
    runMigrations();
    mkdirSync(whisperModelsDir(), { recursive: true });
    writeFileSync(join(whisperModelsDir(), "ggml-small.bin"), "model");
    setMediaWhisperModel("small");
  });

  afterEach(() => {
    closeDb();
    delete process.env.SUPERTWIN_DB_PATH;
    delete process.env.SUPERTWIN_HOME;
    delete process.env.SUPERTWIN_MEDIA_DIR;
  });

  /**
   * One yt-dlp for both jobs: a caption run has --skip-download, a fetch does
   * not. Shell rather than node, because one case spawns these half a dozen
   * times and an interpreter start each time is most of what they cost.
   */
  function stubTracks(opts: { creator?: boolean; auto?: boolean } = {}): void {
    const path = join(tmpDir, "yt-dlp");
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        'skip=0; subs=0; prev=""',
        'for a in "$@"; do',
        '  [ "$a" = "--skip-download" ] && skip=1',
        '  [ "$a" = "--write-subs" ] && subs=1',
        '  if [ "$prev" = "-o" ]; then out="$a"; fi',
        '  prev="$a"',
        "done",
        "if [ $skip -eq 0 ]; then",
        `  echo download >> ${sh(toolCalls)}`,
        '  printf mp4 > "$(dirname "$out")/video.mp4"',
        "  exit 0",
        "fi",
        "if [ $subs -eq 1 ]; then",
        `  kind=creator; have=${opts.creator ? 1 : 0}; said=${sh(CREATOR)}`,
        "else",
        `  kind=auto; have=${opts.auto ? 1 : 0}; said=${sh(AUTO)}`,
        "fi",
        `echo "$kind" >> ${sh(toolCalls)}`,
        "[ $have -eq 1 ] || exit 0",
        `printf 'WEBVTT\\n\\n00:00:01.000 --> 00:00:02.000\\n%s\\n' "$said" \\`,
        `  > "$(printf '%s' "$out" | sed 's/%(ext)s/en.vtt/')"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.SUPERTWIN_YTDLP_BIN = path;
  }

  function stubFfmpeg(): void {
    const path = join(tmpDir, "ffmpeg");
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        'for a in "$@"; do out="$a"; done',
        'case "$out" in',
        '  *.jpg) printf jpeg > "$out"; exit 0 ;;',
        '  *.wav) printf riff > "$out"; echo "max_volume: -3.0 dB" >&2; exit 0 ;;',
        "esac",
        'echo "  Duration: 00:00:30.00, start: 0.0" >&2',
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.SUPERTWIN_FFMPEG_BIN = path;
  }

  function stubWhisper(text: string): void {
    const path = join(tmpDir, "whisper-cli");
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        `echo whisper >> ${sh(toolCalls)}`,
        `printf ' %s' ${sh(text)}`,
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.SUPERTWIN_WHISPER_BIN = path;
  }

  /** Which stub binaries ran, in order. */
  function ran(): string[] {
    if (!existsSync(toolCalls)) return [];
    return readFileSync(toolCalls, "utf8").trim().split("\n").filter(Boolean);
  }

  const bounds = {
    frames: false,
    intervalSec: 5,
    maxFrames: 3,
    audio: true,
    maxHeight: 480,
    eventId: "wa:1203@g.us/ABCD",
  };

  it("prefers the subtitles a person wrote over anything a machine heard", async () => {
    stubTracks({ creator: true, auto: true });
    stubFfmpeg();
    stubWhisper(WHISPER);

    const result = await linkVideoContent(YOUTUBE, { video: bounds });

    expect(result.transcript).toBe(CREATOR);
    // Nothing was downloaded and nothing was listened to: the words are here.
    expect(ran()).toEqual(["creator"]);
  });

  it("still fetches the file for its stills, but does not re-hear it", async () => {
    stubTracks({ creator: true, auto: true });
    stubFfmpeg();
    stubWhisper(WHISPER);

    const result = await linkVideoContent(YOUTUBE, {
      video: { ...bounds, frames: true },
    });

    expect(result.transcript).toBe(CREATOR);
    expect(result.frames).toHaveLength(3);
    expect(ran()).toContain("download");
    expect(ran()).not.toContain("whisper");
  });

  it("uses whisper over YouTube's own robot when nobody wrote subtitles", async () => {
    stubTracks({ auto: true });
    stubFfmpeg();
    stubWhisper(WHISPER);

    const result = await linkVideoContent(YOUTUBE, { video: bounds });

    expect(result.transcript).toBe(WHISPER);
    expect(ran()).toContain("whisper");
    expect(ran()).not.toContain("auto");
  });

  it("falls back to auto-captions only when whisper heard nothing believable", async () => {
    stubTracks({ auto: true });
    stubFfmpeg();
    // Two words over thirty seconds is what whisper invents from music, and
    // v5 §3's density guard refuses it.
    stubWhisper("Thank you.");

    const result = await linkVideoContent(YOUTUBE, { video: bounds });

    expect(result.transcript).toBe(AUTO);
    expect(ran()).toContain("auto");
  });

  it("asks for nothing at all when the page is not a video", async () => {
    stubTracks({ creator: true });
    const result = await linkVideoContent(new URL("https://example.com/post"), {
      video: bounds,
    });
    expect(result).toEqual({ transcript: null, frames: [], error: null });
    expect(ran()).toEqual([]);
  });

  it("takes the captions but downloads nothing when no bounds were given", async () => {
    stubTracks({ auto: true });
    // The queue is what decides a fetch is allowed; without that decision only
    // the caption track — text the page effectively publishes — is read.
    const result = await linkVideoContent(YOUTUBE);
    expect(result.transcript).toBe(AUTO);
    expect(ran()).toEqual(["creator", "auto"]);
  });
});

describe("scrapeLink", () => {
  it("returns the readable text and the page title", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><title>Q3 numbers</title></head><body><p>Revenue rose 12%.</p></body></html>");
    };
    const res = await scrapeLink(`${base}/report`, allowLoopback);

    expect(res).toMatchObject({
      status: "done",
      title: "Q3 numbers",
      scrapedText: "Revenue rose 12%.",
      error: null,
    });
  });

  it("sends a plain user agent and no cookies or credentials", async () => {
    let headers: IncomingMessage["headers"] = {};
    handler = (req, res) => {
      headers = req.headers;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>hi</p>");
    };
    const port = (server.address() as AddressInfo).port;
    // Credentials in the authority must not become an Authorization header.
    await scrapeLink(`http://joe:hunter2@127.0.0.1:${port}/x`, allowLoopback);

    expect(headers["user-agent"]).toMatch(/^SuperTwinV13\//);
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("follows a bounded number of redirects", async () => {
    handler = (req, res) => {
      const n = Number(req.url?.slice(1) ?? 0);
      res.writeHead(302, { location: `${base}/${n + 1}` });
      res.end();
    };
    const res = await scrapeLink(`${base}/0`, { ...allowLoopback, maxRedirects: 2 });

    expect(res.status).toBe("error");
    expect(res.error).toContain("more than 2 redirects");
    expect(hits).toHaveLength(3);
  });

  it("arrives at the page a redirect points to", async () => {
    handler = (req, res) => {
      if (req.url === "/from") {
        res.writeHead(301, { location: "/to" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>There</title><p>Arrived.</p>");
    };
    const res = await scrapeLink(`${base}/from`, allowLoopback);
    expect(res).toMatchObject({ status: "done", title: "There", scrapedText: "Arrived." });
  });

  it("stops reading at the size cap instead of swallowing a huge page", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<p>start ");
      // Far more than the cap; the socket is cut before it all arrives.
      for (let i = 0; i < 200; i++) res.write("word ".repeat(820));
      res.end("</p>");
    };
    const res = await scrapeLink(`${base}/big`, { ...allowLoopback, maxBytes: 4096 });

    expect(res.status).toBe("done");
    expect(res.scrapedText?.startsWith("start")).toBe(true);
    expect(res.scrapedText!.length).toBeLessThanOrEqual(MAX_SCRAPED_CHARS);
  });

  // The v6 §4 bug, as bytes: the cap lands inside a <script>, so the closing
  // tag never arrives. What used to be stored for all 32 link rows was the
  // JavaScript that followed.
  it("does not store the script a truncated body ends inside", async () => {
    const script = `var ytcfg={};ytcfg.set({"CLIENT":"WEB","DELEGATED":[["k",[1,2]]],`;
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><head><title>Watch</title></head><body><script>");
      for (let i = 0; i < 200; i++) res.write(script);
      // </script>, </body> and the page's real text never arrive.
    };
    const res = await scrapeLink(`${base}/watch`, {
      ...allowLoopback,
      maxBytes: 4096,
      timeoutMs: 2000,
    });

    expect(res.status).not.toBe("done");
    expect(res.scrapedText).toBeNull();
  });

  it("refuses a page that is code all the way down", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`{"require":[["ScheduledServerJS",[],[],[]]],"a":{"b":[1,2,3]}}`);
    };
    const res = await scrapeLink(`${base}/bundle.js`, allowLoopback);

    expect(res.status).toBe("error");
    expect(res.error).toContain("code");
    expect(res.scrapedText).toBeNull();
  });

  // YouTube's og:title sits 683 KB into a 1.5 MB document, past every fixed cap
  // this file used to apply.
  it("reads past the old cap to reach metadata at the end of a huge head", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><head><script>");
      for (let i = 0; i < 160; i++) res.write(`var ytcfg${i}={"a":[[1,2],[3,4]]};`.repeat(100));
      res.write("</script>");
      res.write('<meta property="og:title" content="A talk about ferries">');
      res.write('<meta property="og:description" content="Ferries run hourly from the pier.">');
      res.write("</head><body><script>var ytInitialData={};</script></body></html>");
      res.end();
    };
    const res = await scrapeLink(`${base}/watch`, allowLoopback);

    expect(res).toMatchObject({
      status: "done",
      title: "A talk about ferries",
      scrapedText: "Ferries run hourly from the pier.",
    });
  });

  it("stops once the head has closed rather than reading a whole page", async () => {
    let written = 0;
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write('<html><head><meta name="description" content="Short and early."></head>');
      res.write("<body><main><p>The article.</p>");
      const filler = "word ".repeat(2048); // 10 KB a piece
      const push = (): void => {
        while (written < 400 && res.write(filler)) written++;
      };
      res.on("drain", push);
      push();
    };
    const res = await scrapeLink(`${base}/article`, {
      ...allowLoopback,
      maxBytes: 64 * 1024,
      timeoutMs: 5000,
    });

    expect(res.status).toBe("done");
    expect(res.scrapedText?.startsWith("Short and early.\nThe article.")).toBe(true);
    // The body budget is a fraction of what the server was willing to send.
    expect(written).toBeLessThan(400);
  });

  it("reads a gzipped page rather than storing its bytes as text", async () => {
    handler = (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
      });
      res.end(gzipSync(Buffer.from("<title>Zipped</title><p>Inflated fine.</p>")));
    };
    const res = await scrapeLink(`${base}/gz`, allowLoopback);
    expect(res).toMatchObject({ status: "done", scrapedText: "Inflated fine." });
  });

  it("keeps what a gzipped page sent before the cap cut it", async () => {
    const body = `<html><head><meta name="description" content="Head of the page."></head><body><main><p>${"word ".repeat(40_000)}</p></main></body></html>`;
    handler = (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
      });
      res.end(gzipSync(Buffer.from(body)));
    };
    const res = await scrapeLink(`${base}/gzbig`, {
      ...allowLoopback,
      maxBytes: 8192,
    });

    expect(res.status).toBe("done");
    expect(res.scrapedText?.startsWith("Head of the page.\nword word")).toBe(true);
  });

  it("records an HTTP failure as retryable, with the status in the reason", async () => {
    handler = (_req, res) => {
      res.writeHead(503);
      res.end("nope");
    };
    const res = await scrapeLink(`${base}/down`, allowLoopback);

    expect(res).toMatchObject({ status: "error", scrapedText: null, title: null });
    expect(res.error).toContain("503");
  });

  it("a PDF behind a link is not a page — unsupported, never guessed at", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.4");
    };
    const res = await scrapeLink(`${base}/doc.pdf`, allowLoopback);

    expect(res.status).toBe("unsupported");
    expect(res.scrapedText).toBeNull();
    expect(res.error).toContain("application/pdf");
  });

  it("a page with no readable text stores none", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Only a title</title></head><body></body></html>");
    };
    const res = await scrapeLink(`${base}/empty`, allowLoopback);

    expect(res.status).toBe("unsupported");
    expect(res.scrapedText).toBeNull();
  });

  it("gives up on a page that never finishes", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<p>waiting");
      // never ends
    };
    const res = await scrapeLink(`${base}/hang`, {
      ...allowLoopback,
      timeoutMs: 150,
    });

    expect(res.status).toBe("error");
    expect(res.error).toContain("timed out");
  });
});
