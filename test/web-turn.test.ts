import { describe, expect, it } from "vitest";
import { makeSpeaker, type PlaybackResult } from "../src/web/speaker.js";
import { browserFamily, browserLabel, chooseVoice, formatTiming, makeTurnDetector, medianOf, parseSse, phaseLabel, spokenText, timingStages, TURN } from "../src/web/turn-lib.js";

describe("parseSse (#82)", () => {
  it("reads complete events and keeps the unfinished rest, across chunk splits", () => {
    const first = parseSse('event: start\ndata: {"turnId":"t-1"}\n\nevent: sentence\ndata: {"index":0,');
    expect(first.events).toEqual([{ event: "start", data: '{"turnId":"t-1"}' }]);
    const second = parseSse(`${first.rest}"text":"Hi."}\n\n: keep-alive\n\nevent: done\r\ndata: {}\r\n\r\n`);
    expect(second.events).toEqual([
      { event: "sentence", data: '{"index":0,"text":"Hi."}' },
      { event: "done", data: "{}" },
    ]);
    expect(second.rest).toBe("");
    expect(parseSse("data: a\ndata: b\n\n").events).toEqual([{ event: "message", data: "a\nb" }]);
  });
});

describe("spokenText (#75)", () => {
  const s = ["Your passport expires in January.", "Renew it by December, to be safe.", "Want a reminder?"];
  it("keeps the sentences played and the share of the cut one, ending in —", () => {
    expect(spokenText(s, { full: 3 })).toBe(s.join(" "));
    expect(spokenText(s, { full: 1 })).toBe(s[0]);
    expect(spokenText(s, { full: 1, cutFraction: 0.5 })).toBe("Your passport expires in January. Renew it by—");
    expect(spokenText(s, { full: 0, cutFraction: 0.4 })).toBe("Your passport—");
    expect(spokenText(s, { full: 0, cutFraction: 0.05 })).toBe("");
    expect(spokenText(s, { full: 1, cutFraction: 0.05 })).toBe("Your passport expires in January.—");
    expect(spokenText(s, { full: 1, cutFraction: 1 })).toBe("Your passport expires in January. Renew it by December, to be safe—");
  });
});

describe("chooseVoice (#82)", () => {
  const kokoro = (available: boolean) => ({
    provider: "kokoro",
    voice: "bm_daniel",
    providers: [{ id: "kokoro", available, ...(available ? {} : { problem: "Kokoro isn't running at http://127.0.0.1:8880 (npm run voice:up)" }) }],
  });
  it("uses the configured voice when it's running, else the browser's with why", () => {
    expect(chooseVoice(kokoro(true))).toEqual({ server: { provider: "kokoro", voice: "bm_daniel" }, note: "" });
    expect(chooseVoice(kokoro(false))).toEqual({
      server: null,
      note: "Kokoro isn't running at http://127.0.0.1:8880 (npm run voice:up), so Jarvis is using the browser voice.",
    });
    expect(chooseVoice({ provider: "browser", voice: "", providers: [] })).toEqual({ server: null, note: "" });
    expect(chooseVoice({ ...kokoro(true), voice: "" }).note).toContain("No kokoro voice is set");
    expect(chooseVoice(null).server).toBeNull();
  });
});

/** A fake player: each sentence takes `ms`; stopping reports the share played. */
const fakeAudio = (ms = 20) => {
  const log: string[] = [];
  const play = async (response: Response, signal: AbortSignal, tracker: { fraction: () => number }) => {
    const text = await response.text();
    log.push(`play ${text}`);
    const started = Date.now();
    tracker.fraction = () => Math.min(1, (Date.now() - started) / ms);
    return new Promise<{ playedSeconds: number; totalSeconds: number; stopped: boolean }>((resolve) => {
      const t = setTimeout(() => resolve({ playedSeconds: ms / 1000, totalSeconds: ms / 1000, stopped: false }), ms);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve({ playedSeconds: (Date.now() - started) / 1000, totalSeconds: ms / 1000, stopped: true });
      });
    });
  };
  const speakBrowser = async (text: string, signal: AbortSignal, tracker: { fraction: () => number }) => {
    log.push(`browser ${text}`);
    tracker.fraction = () => 0.5;
    return signal.aborted ? { fraction: 0, stopped: true } : { fraction: 1, stopped: false };
  };
  return { log, play, speakBrowser };
};

const run = (over: Partial<Parameters<typeof makeSpeaker>[0]> = {}, ms = 20) => {
  const audio = fakeAudio(ms);
  const fetches: string[] = [];
  let result: PlaybackResult | undefined;
  const notes: string[] = [];
  const ctx: { speaker?: ReturnType<typeof makeSpeaker> } = {};
  const done = new Promise<PlaybackResult>((resolve) => {
    const speaker = makeSpeaker({
      fetchSpeech: async (text) => {
        fetches.push(text);
        return new Response(text);
      },
      play: audio.play,
      speakBrowser: audio.speakBrowser,
      onFallback: (why) => notes.push(why),
      onDone: (r) => {
        result = r;
        resolve(r);
      },
      ...over,
    });
    ctx.speaker = speaker;
  });
  const speaker = () => {
    if (!ctx.speaker) throw new Error("no speaker");
    return ctx.speaker;
  };
  return { speaker, done, fetches, log: audio.log, notes, result: () => result };
};

describe("makeSpeaker (#82)", () => {
  it("plays sentences in order as they stream in, fetching ahead, then reports played to the end", async () => {
    const r = run();
    const sp = r.speaker();
    sp.say("One.");
    sp.say("Two.");
    expect(r.fetches).toEqual(["One.", "Two."]); // the first two straight away
    sp.say("Three.");
    expect(r.fetches).toEqual(["One.", "Two."]); // the third waits for playback to reach it
    sp.finish();
    expect(await r.done).toEqual({ interrupted: false, spoken: "One. Two. Three.", sentences: 3, fellBack: false });
    expect(r.log).toEqual(["play One.", "play Two.", "play Three."]);
    expect(r.fetches).toEqual(["One.", "Two.", "Three."]);
  });

  it("stops at once, reporting what was said, synchronously", async () => {
    const r = run({}, 200);
    const sp = r.speaker();
    sp.say("Your passport expires in January.");
    sp.say("Renew it by December, to be safe.");
    await new Promise((x) => setTimeout(x, 300)); // the first has played; the second is part-way
    sp.stop();
    const result = r.result(); // already known, before any await
    expect(result?.interrupted).toBe(true);
    expect(result?.spoken.startsWith("Your passport expires in January. ")).toBe(true);
    expect(result?.spoken.endsWith("—")).toBe(true);
    sp.stop(); // a second stop is a no-op
    expect(r.result()).toBe(result);
  });

  it("falls back to the browser voice when /speak fails, with the reason", async () => {
    const r = run({
      fetchSpeech: async () => new Response(JSON.stringify({ type: "error", message: "Kokoro isn't running" }), { status: 503 }),
    });
    const sp = r.speaker();
    sp.say("Hello.");
    sp.say("Again.");
    sp.finish();
    expect(await r.done).toMatchObject({ interrupted: false, spoken: "Hello. Again.", fellBack: true });
    expect(r.notes).toEqual(["Kokoro isn't running"]);
    expect(r.log).toEqual(["browser Hello.", "browser Again."]);
  });

  it("uses the browser voice alone when no server voice is set, and says nothing when muted", async () => {
    const browser = run({ fetchSpeech: null });
    browser.speaker().say("Hi.");
    browser.speaker().finish();
    expect(await browser.done).toMatchObject({ interrupted: false, fellBack: false });
    expect(browser.log).toEqual(["browser Hi."]);

    const muted = run({ muted: true });
    muted.speaker().say("Hi.");
    muted.speaker().finish();
    expect(await muted.done).toMatchObject({ interrupted: false, spoken: "Hi." });
    expect(muted.log).toEqual([]);
    expect(muted.fetches).toEqual([]);
  });

  it("counts a stop before anything played as interrupted with nothing said", () => {
    const r = run();
    r.speaker().say("Hello there.");
    r.speaker().stop();
    expect(r.result()).toEqual({ interrupted: true, spoken: "", sentences: 1, fellBack: false });
  });
});

describe("phaseLabel (#75)", () => {
  it("says what's happening, and how to interrupt while speaking", () => {
    expect(phaseLabel("thinking", "en")).toBe("Thinking…");
    expect(phaseLabel("speaking", "en")).toBe("Speaking…");
    expect(phaseLabel("speaking", "en", "vad")).toBe("Speaking… just talk to interrupt");
    expect(phaseLabel("speaking", "en", "push")).toBe("Speaking… tap ✋ Interrupt or press Space");
    expect(phaseLabel("listening", "pt", "vad")).toBe("A ouvir… diz “é tudo” para parar");
    expect(phaseLabel("idle", "en")).toBe("");
  });
});

describe("browserFamily (#75)", () => {
  it("tells Safari from Chrome (whose user agent also says Safari)", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    expect(browserFamily(`${mac} Version/18.1 Safari/605.1.15`)).toBe("safari");
    expect(browserFamily(`${mac} Chrome/131.0.0.0 Safari/537.36`)).toBe("chrome");
    expect(browserFamily(`${mac} Chrome/131.0.0.0 Safari/537.36 Edg/131.0`)).toBe("chrome");
    expect(browserFamily("Mozilla/5.0 (Macintosh; rv:133.0) Gecko/20100101 Firefox/133.0")).toBe("firefox");
    expect(browserFamily("curl/8")).toBe("other");
  });
});

describe("makeTurnDetector (#75)", () => {
  const frames = (p: number, ms: number) => Array.from({ length: Math.round(ms / TURN.frameMs) }, () => p);
  const feed = (d: ReturnType<typeof makeTurnDetector>, ps: number[], talking = false) => ps.map((p) => d.feed(p, talking));

  it("starts on speech and ends the turn after the configured silence (500 ms by default)", () => {
    const d = makeTurnDetector();
    const events = feed(d, [...frames(0.05, 320), ...frames(0.9, 960), ...frames(0.1, 600)]);
    expect(events.indexOf("start")).toBe(10 + Math.ceil(TURN.minSpeechMs / TURN.frameMs) - 1);
    const end = events.indexOf("end");
    expect(end).toBe(10 + 30 + Math.ceil(500 / TURN.frameMs) - 1); // 16 quiet frames = 512 ms
    expect(events.slice(end + 1).every((e) => e === "quiet")).toBe(true);
    // From ~320 ms before speech to ~200 ms into the pause, as frame numbers [from, to).
    expect(d.span()).toEqual({ from: 1, to: 10 + 30 + 16 - (16 - 6) + 1 });
  });

  it("is tunable, and isn't ended by a short pause between words", () => {
    const d = makeTurnDetector({ endSilenceMs: 800 });
    const events = feed(d, [...frames(0.9, 320), ...frames(0.1, 600), ...frames(0.9, 320), ...frames(0.1, 800)]);
    expect(events.filter((e) => e === "start")).toHaveLength(1);
    expect(events.filter((e) => e === "end")).toHaveLength(1);
    expect(events.indexOf("end")).toBeGreaterThan(30);
  });

  it("ignores a click, and gives up when nothing is said", () => {
    const d = makeTurnDetector({ noSpeechMs: 2000 });
    const events = feed(d, [...frames(0.1, 320), ...frames(0.95, 64), ...frames(0.1, 2000)]);
    expect(events).not.toContain("start");
    expect(events.at(-1)).toBe("quiet");
    expect(events).toContain("no-speech");
  });

  it("stops an utterance that runs too long", () => {
    const d = makeTurnDetector();
    const events = feed(d, frames(0.9, TURN.maxMs + 500));
    expect(events).toContain("max");
  });

  it("while Jarvis talks, interrupts only on enough speech, then listens to it", () => {
    const vad = makeTurnDetector({ bargeIn: "vad" });
    expect(feed(vad, [...frames(0.9, 128), 0.1], true)).not.toContain("barge-in"); // a cough
    const barge = feed(vad, frames(0.9, 224), true);
    expect(barge.at(-1)).toBe("barge-in"); // 7 frames = 224 ms
    expect(vad.heard()).toBe(true);
    // The interruption is the start of the next utterance.
    const after = feed(vad, [...frames(0.9, 320), ...frames(0.1, 520)]);
    expect(after.at(-1)).toBe("end");
    expect(vad.span().from).toBeLessThan(5);

    const strict = makeTurnDetector({ bargeIn: "strict" });
    expect(feed(strict, frames(0.7, 2000), true)).not.toContain("barge-in"); // echo-ish: not sure enough
    expect(feed(strict, [...frames(0.95, 320), 0.1], true)).not.toContain("barge-in"); // too short
    expect(feed(strict, frames(0.95, 480), true).at(-1)).toBe("barge-in"); // 15 frames = 480 ms

    const push = makeTurnDetector({ bargeIn: "push" });
    expect(feed(push, frames(0.99, 3000), true)).not.toContain("barge-in");
    push.interrupt();
    expect(feed(push, [...frames(0.9, 320), ...frames(0.1, 520)]).at(-1)).toBe("end");
  });

  it("joins speech after the end of a turn to that turn, when asked", () => {
    const d = makeTurnDetector();
    feed(d, [...frames(0.1, 320), ...frames(0.9, 320), ...frames(0.1, 520)]);
    const first = d.span();
    // Still thinking: you carry on talking, and it's one utterance.
    expect(feed(d, frames(0.9, 224), true).at(-1)).toBe("barge-in");
    d.continueFrom(first.from + 10);
    feed(d, [...frames(0.9, 320), ...frames(0.1, 520)]);
    expect(d.span().from).toBe(first.from);
  });

  it("listens afresh after a turn", () => {
    const d = makeTurnDetector();
    feed(d, [...frames(0.9, 320), ...frames(0.1, 520)]);
    expect(feed(d, frames(0.9, 320))).not.toContain("start"); // ended: waits for listen()
    d.listen();
    expect(feed(d, frames(0.9, 320))).toContain("start");
  });
});

describe("turn timings (#76)", () => {
  const spoken = {
    spoken: true,
    speechEndedAt: 1000,
    endOfTurnMs: 512,
    whisperMs: 310,
    whisperServerMs: 290,
    askAt: 1830,
    firstSentenceAt: 2500,
    server: { route: "classifier", routeMs: 280, memoriesMs: 3, firstTokenMs: 640, firstSentenceMs: 650, totalMs: 2100 },
    speakAt: 2505,
    firstSoundAt: 2760,
    voice: "kokoro",
  };

  it("derives each stage, the total running from the end of your speech to the first sound", () => {
    expect(timingStages(spoken)).toEqual({
      endOfTurnMs: 512,
      whisperMs: 310,
      whisperServerMs: 290,
      route: "classifier",
      routeMs: 280,
      memoriesMs: 3,
      firstTokenMs: 640,
      firstSentenceMs: 670,
      voiceFirstAudioMs: 255,
      totalMs: 1760,
    });
    // Typed: from pressing Send.
    expect(timingStages({ spoken: false, askAt: 100, firstSoundAt: 1400 }).totalMs).toBe(1300);
    expect(timingStages({ spoken: true, speechEndedAt: 5 }).totalMs).toBeUndefined(); // no sound yet
  });

  it("formats the dev line: stages, total and median, and no text", () => {
    expect(formatTiming(timingStages(spoken), "kokoro", { median: 1900, count: 4 })).toBe(
      "end of turn 512 ms · Whisper 310 ms · classifier 280 ms · Claude first sentence 670 ms (first token 640 ms) · kokoro first audio 255 ms · total 1.76 s · median 1.90 s (4)",
    );
    expect(formatTiming(timingStages({ ...spoken, server: { route: "precheck", routeMs: 0 } }), "kokoro")).toContain("precheck (no classifier)");
  });

  it("labels the browser with its major version, and takes medians", () => {
    expect(browserLabel("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15")).toBe("safari 18");
    expect(browserLabel("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")).toBe("chrome 131");
    expect(browserLabel("curl/8")).toBe("other");
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 2, 3])).toBe(3); // 2.5 rounded
    expect(medianOf([])).toBe(0);
  });
});
