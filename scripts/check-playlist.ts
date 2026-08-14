/**
 * 행사 전 플레이리스트 점검.
 *
 *   node scripts/check-playlist.ts data/playlist.top100.txt
 *
 * 두 가지를 봅니다. **링크가 살아 있는지**, 그리고 **적어 둔 정답이 그 영상의
 * 제목과 맞는지**. 둘 다 조용히 틀리는 종류의 문제라, 행사장에서 발견하면
 * 이미 늦습니다.
 *
 * 임베드 차단(업로더가 외부 재생을 막아 둔 경우)은 **여기서 확인하지
 * 않습니다.** 그 값은 공개 API 에 없고 watch 페이지를 긁어야 하는데, 백 곡을
 * 연달아 긁으면 유튜브가 봇으로 보고 사람 확인 페이지를 돌려주기 시작합니다.
 * 그러면 결과가 전부 "판정 불가"가 되어 아무 쓸모가 없어집니다. 확실하지 않은
 * 것을 확실한 척 보고하느니 확인하지 않는다고 적는 편이 낫습니다 — 임베드
 * 차단은 리허설 때 실제로 재생해 보는 것으로만 확실히 걸러집니다.
 *
 * 종료 코드는 문제가 있으면 1입니다.
 */

import { readFileSync } from 'node:fs';
import { parsePlaylist } from '../shared/playlist.ts';
import { normalizeAnswer } from '../shared/answerMatching.ts';
import { lookupVideo } from '../server/youtubeLookup.ts';

/** 동시 요청 수. 100곡을 30초 안에 끝내면서 유튜브를 두드리지 않는 선. */
const CONCURRENCY = 4;

type Verdict = 'OK' | 'UNAVAILABLE' | 'LOOKUP_FAILED';

interface Checked {
  line: number;
  videoId: string;
  answers: string[];
  verdict: Verdict;
  title: string;
  detail: string;
}

const MESSAGE: Record<Verdict, string> = {
  OK: '정상',
  UNAVAILABLE: '삭제·비공개·지역 제한 — 다른 링크로 교체하세요',
  LOOKUP_FAILED: '조회 실패 — 인터넷 연결을 확인하세요',
};

/**
 * 영상 하나를 확인합니다. 서버가 쓰는 것과 같은 oEmbed 조회입니다 — 키가
 * 필요 없고, 백 번을 연달아 불러도 막히지 않으며, 없는 영상에는 확실히
 * 실패합니다.
 */
async function check(videoId: string): Promise<{ verdict: Verdict; title: string; detail: string }> {
  const found = await lookupVideo(videoId);
  if (found.ok) return { verdict: 'OK', title: found.title, detail: '' };
  return {
    verdict: found.message.includes('연결') ? 'LOOKUP_FAILED' : 'UNAVAILABLE',
    title: '',
    detail: found.message,
  };
}

/** 요청을 CONCURRENCY 개씩 묶어 보내되, 결과는 파일에 적힌 순서대로 돌려줍니다. */
async function checkAll(
  entries: readonly { line: number; videoId: string; answers: string[] }[],
): Promise<Checked[]> {
  const out: Checked[] = [];
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const checked = await Promise.all(batch.map((entry) => check(entry.videoId)));
    batch.forEach((entry, index) => out.push({ ...entry, ...checked[index]! }));
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return out;
}

function main(): Promise<void> | void {
  const file = process.argv[2];
  if (file === undefined) {
    console.error('사용법: node scripts/check-playlist.ts <플레이리스트 txt>');
    process.exitCode = 1;
    return;
  }

  const { entries, problems } = parsePlaylist(readFileSync(file, 'utf8'));

  for (const problem of problems) {
    console.error(`  ${file}:${problem.line}  ${problem.message}`);
    console.error(`    ${problem.text}`);
  }
  if (entries.length === 0) {
    console.error('\n확인할 링크가 없습니다.');
    process.exitCode = 1;
    return;
  }

  console.log(`${entries.length}곡을 확인합니다…`);
  return checkAll(entries).then((results) => {
    const bad = results.filter((r) => r.verdict !== 'OK');
    console.log(`\n전체 ${results.length}곡 · 정상 ${results.length - bad.length}곡 · 확인 필요 ${bad.length}곡`);

    for (const r of bad) {
      console.log(`\n  ${r.line}행  [${MESSAGE[r.verdict]}]  ${r.answers[0] ?? ''}`);
      console.log(`        https://youtu.be/${r.videoId}${r.detail === '' ? '' : `  (${r.detail})`}`);
    }

    // 정답을 잘못 적은 줄은 재생과 무관하게 게임을 망칩니다. 영상 제목에
    // 정답이 하나도 안 보이면 사람이 한 번 봐야 합니다 — 커버 영상이나
    // 다른 곡을 붙여 넣었을 수 있습니다.
    const suspicious = results.filter(
      (r) =>
        r.title !== '' &&
        !r.answers.some((answer) => normalizeAnswer(r.title).includes(normalizeAnswer(answer))),
    );
    if (suspicious.length > 0) {
      console.log(`\n정답이 영상 제목에 없는 곡 ${suspicious.length}개 — 오타나 링크 착각일 수 있습니다:`);
      for (const r of suspicious) {
        console.log(`  ${r.line}행  "${r.answers.join(', ')}"  ←  ${r.title}`);
      }
    }

    console.log(
      '\n외부 재생(임베드) 차단 여부는 확인하지 않았습니다. 그건 행사 전에 실제로\n' +
        '한 판 돌려 보는 것으로만 걸러집니다 — 차단된 영상은 방장 화면에\n' +
        '"이 영상은 외부 재생이 막혀 있습니다"라고 뜹니다.',
    );

    if (bad.length > 0 || problems.length > 0) process.exitCode = 1;
    else if (suspicious.length === 0) console.log('\n링크와 정답은 모두 정상입니다.');
  });
}

void main();
