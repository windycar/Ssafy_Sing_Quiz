import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html", host: "localhost" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Drop the Beat lobby", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /DROP THE BEAT/);
  assert.match(html, /ONLINE MUSIC QUIZ/);
  // The home screen is what is server-rendered: joining a room, and creating
  // one. The lobby and the play screens live behind client state, so asserting
  // on their copy here only ever tested the bundler.
  assert.match(html, /방 참여/);
  assert.match(html, /방 만들기/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("the room-creation screen offers the three modes, in order", async () => {
  // Server-rendered, so this is the real markup a host is handed rather than a
  // claim about the source.
  const html = await (await render()).text();

  const song = html.indexOf("노래 맞히기");
  const proverb = html.indexOf("속담 맞히기");
  const idiom = html.indexOf("사자성어 맞히기");

  assert.ok(song >= 0, "노래 맞히기 is missing from the mode selector");
  assert.ok(proverb >= 0, "속담 맞히기 is missing from the mode selector");
  assert.ok(idiom >= 0, "사자성어 맞히기 is missing from the mode selector");
  assert.ok(song < proverb && proverb < idiom, "the modes must read 노래 → 속담 → 사자성어");

  assert.match(html, /name="game-mode"/, "the modes have to be one radio group");
  assert.match(html, /value="proverb"/);
  assert.match(html, /value="idiom"/);
});

test("no question bank answer is served to a client", async () => {
  // The banks are server-side data. If any of it were imported into the page
  // it would be in the bundle, and this is where that shows up.
  const html = await (await render()).text();
  const banks = await Promise.all([
    readFile(new URL("../../data/proverbs.json", import.meta.url), "utf8"),
    readFile(new URL("../../data/idioms.json", import.meta.url), "utf8"),
  ]);

  for (const [name, raw] of [["proverbs", banks[0]], ["idioms", banks[1]]]) {
    const parsed = JSON.parse(raw);
    const records = parsed.proverbs ?? parsed.idioms;
    for (const record of records) {
      for (const answer of [record.full, record.suffix, record.answer, record.hanja]) {
        if (typeof answer !== "string" || answer === "") continue;
        assert.ok(!html.includes(answer), `${name}: "${answer}" was served to the client`);
      }
    }
  }
});

test("the game screen renders the clue, progress, and scorers from server state", async () => {
  // The play screens are client-rendered, so the assertion is on the source:
  // every one of these has to come out of the protocol message rather than out
  // of anything this file worked out for itself.
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  // The clue card replaces the media stage in a text round.
  assert.match(page, /className="clue-card"/, "no clue card");
  assert.match(page, /round\?\.question\.clue/, "the clue must come from ROUND_START");
  assert.match(page, /textMode \? \(/, "the clue card and the vinyl must be alternatives");

  // 현재 문제 / 30, both halves from the server.
  assert.match(page, /round\?\.question\.index \?\? 0/);
  assert.match(page, /\{totalQuestions\}/);

  // The reveal draws the proverb in two parts and lists every scorer in order.
  assert.match(page, /reveal\.answer\.clue/);
  assert.match(page, /reveal\.answer\.detail/);
  assert.match(page, /reveal\.answer\.hanja/);
  assert.match(page, /reveal\.scorers\.map/);
  assert.match(page, /entry\.pointsAwarded/);
  assert.doesNotMatch(page, /scorers\.(sort|slice|filter)\(/, "the client must not reorder the scorers");

  // And the mode itself is the server's, shown in the lobby.
  assert.match(page, /MODE_LABEL\[mode\]/);
});

test("the React client never judges an answer", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  // `normalizeAnswer` is imported to show a player what their typing reduces
  // to. Nothing else from the matching side may be.
  assert.doesNotMatch(page, /createAliasMatcher|isCorrectAnswer|normalizedAliases/);
  assert.doesNotMatch(page, /questionBanks|PROVERB_BANK|IDIOM_BANK/);

  // Checked against the source with comments stripped: the file's own header
  // explains that aliases never reach it and that nothing may opt out of JSX
  // escaping, and those sentences are not the violation.
  const code = page.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /\baliases\b/);
  // React escapes JSX text, and nothing here opts out of that.
  assert.doesNotMatch(code, /dangerouslySetInnerHTML/);
});

test("ships product metadata, social card, and no starter preview", async () => {
  const [layout, packageJson] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /Drop the Beat/);
  assert.match(layout, /og\.png/);
  assert.match(packageJson, /drop-the-beat-music-quiz/);
  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

